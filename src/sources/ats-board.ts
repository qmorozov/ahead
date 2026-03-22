import axios, { AxiosError } from "axios";
import { Job } from "../types";
import {
  getActiveSlugs,
  getStaleSlugs,
  updateBoard,
  getEtag,
  setEtag,
  increment304,
  reset304,
} from "../db";
import { log, debug } from "../lib/logger";
import { errorMessage } from "../lib/utils";

interface ATSBoardConfig {
  platform: string;
  label: string;
  batchSize: number;
  boardsPerCycle: number;
  buildUrl: (slug: string) => string;
  requestParams?: Record<string, string>;
  parseJobs: (data: unknown, slug: string) => Job[];
  accept429?: boolean;
}

interface FetchResult {
  jobs: Job[];
  notModified: boolean;
}

interface CycleStats {
  fetched200: number;
  cached304: number;
  dead404: number;
  timeouts: number;
  rateLimited: number;
  errors: number;
  newJobs: number;
  withDescription: number;
}

function emptyStats(): CycleStats {
  return {
    fetched200: 0,
    cached304: 0,
    dead404: 0,
    timeouts: 0,
    rateLimited: 0,
    errors: 0,
    newJobs: 0,
    withDescription: 0,
  };
}

function formatStats(
  label: string,
  stats: CycleStats,
  totalJobs: number,
  totalBoards: number,
): string {
  const parts = [
    `${totalJobs} jobs from ${totalBoards} boards`,
    `200:${stats.fetched200}`,
    `304:${stats.cached304}`,
  ];
  if (stats.dead404 > 0) parts.push(`404:${stats.dead404}`);
  if (stats.timeouts > 0) parts.push(`timeout:${stats.timeouts}`);
  if (stats.rateLimited > 0) parts.push(`429:${stats.rateLimited}`);
  if (stats.errors > 0) parts.push(`err:${stats.errors}`);
  if (stats.newJobs > 0) parts.push(`+${stats.newJobs} new`);
  return `${label}: ${parts.join(", ")}`;
}

/** Create a reusable fetcher that polls ATS boards with ETag caching and batch concurrency. */
export function createATSBoardFetcher(config: ATSBoardConfig): () => Promise<Job[]> {
  const jobsBySlug = new Map<string, Job[]>();
  const timeoutStrikes = new Map<string, number>();
  let warmup = false;

  async function fetchBoard(slug: string): Promise<FetchResult> {
    const etag = warmup ? null : getEtag(slug, config.platform);
    const headers: Record<string, string> = {};
    if (etag) headers["If-None-Match"] = etag;

    const {
      data,
      status,
      headers: resHeaders,
    } = await axios.get(config.buildUrl(slug), {
      params: config.requestParams,
      timeout: 5000,
      headers,
      validateStatus: (s) => s === 200 || s === 304 || (config.accept429 === true && s === 429),
    });

    if (status === 429) throw new Error("429 Rate Limited");
    if (status === 304) return { jobs: [], notModified: true };

    const newEtag = resHeaders["etag"] as string | undefined;
    if (newEtag) setEtag(slug, config.platform, newEtag);

    const jobs = config.parseJobs(data, slug);
    for (const j of jobs) j.boardJobCount = jobs.length;
    updateBoard(slug, config.platform, true, jobs.length);

    return { notModified: false, jobs };
  }

  function handleSuccess(slug: string, result: FetchResult, stats: CycleStats): void {
    timeoutStrikes.delete(slug);

    if (result.notModified) {
      stats.cached304++;
      increment304(slug, config.platform);
      updateBoard(slug, config.platform, true, jobsBySlug.get(slug)?.length ?? 0);
      return;
    }

    stats.fetched200++;
    if (!warmup) reset304(slug, config.platform);

    if (result.jobs.length > 0) {
      const prevCount = jobsBySlug.get(slug)?.length ?? 0;
      jobsBySlug.set(slug, result.jobs);
      stats.newJobs += Math.max(0, result.jobs.length - prevCount);
      stats.withDescription += result.jobs.filter((j) => Boolean(j.description)).length;
    } else {
      jobsBySlug.delete(slug);
    }
  }

  function handleError(slug: string, reason: unknown, stats: CycleStats): void {
    const status = reason instanceof AxiosError ? reason.response?.status : undefined;
    const code = reason instanceof AxiosError ? reason.code : undefined;

    if (status === 429) {
      stats.rateLimited++;
      return;
    }

    if (status === 404) {
      stats.dead404++;
      updateBoard(slug, config.platform, false, 0);
      jobsBySlug.delete(slug);
      return;
    }

    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
      stats.timeouts++;
      const strikes = (timeoutStrikes.get(slug) ?? 0) + 1;
      timeoutStrikes.set(slug, strikes);
      // Don't deactivate boards on warmup - transient timeouts during mass fetch are normal.
      // Only deactivate after 3 consecutive timeout strikes during regular cycles.
      if (!warmup && strikes >= 3) {
        updateBoard(slug, config.platform, false, 0);
        jobsBySlug.delete(slug);
        timeoutStrikes.delete(slug);
      }
      return;
    }

    stats.errors++;
    debug(`${config.label} [${slug}]: ${errorMessage(reason)}`);
  }

  function allJobs(): Job[] {
    return [...jobsBySlug.values()].flat();
  }

  return async function fetchAll(): Promise<Job[]> {
    warmup = jobsBySlug.size === 0;
    const stale = warmup ? getActiveSlugs(config.platform) : getStaleSlugs(config.platform, 3600);

    if (stale.length === 0) {
      debug(
        `${config.label}: nothing stale, returning ${allJobs().length} cached jobs from ${jobsBySlug.size} boards`,
      );
      return allJobs();
    }

    const checkSlugs = stale.slice(0, config.boardsPerCycle);
    log(
      `${config.label}: ${warmup ? "WARMUP " : ""}checking ${checkSlugs.length} of ${stale.length} stale boards (batch=${config.batchSize})...`,
    );

    const stats = emptyStats();

    for (let i = 0; i < checkSlugs.length; i += config.batchSize) {
      const batch = checkSlugs.slice(i, i + config.batchSize);
      const results = await Promise.allSettled(batch.map(fetchBoard));

      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const slug = batch[j]!;

        if (r.status === "fulfilled") handleSuccess(slug, r.value, stats);
        else handleError(slug, r.reason, stats);
      }

      if (stats.rateLimited > 5) {
        log(`${config.label}: too many 429s, stopping early`);
        break;
      }
    }

    const jobs = allJobs();
    log(formatStats(config.label, stats, jobs.length, jobsBySlug.size));
    return jobs;
  };
}
