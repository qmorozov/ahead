import fs from "fs";
import path from "path";
import { sources, fetchWithRetry } from "../sources";
import {
  filterJobs,
  buildScoringContext,
  scoreJob,
  computeThreshold,
  clearCachedContext,
  loadFeedbackIntoContext,
  ScoringContext,
} from "./filter";
import { sendJobBatch, sendJobs } from "../bot/delivery";
import { config } from "../config";
import { POLLING, LLM } from "../constants";
import {
  UserSettings,
  loadOnboardedSettings,
  pruneParsedCache,
  pruneCompanyUrls,
  pruneSeen,
  loadSeenKeys,
  markSeenBatch,
  isFirstRun,
  incrementJobsSent,
  loadSeenTitles,
  markTitleSeenBatch,
  pruneSeenTitles,
  loadDeferredForChat,
  flushDeferredBatch,
  pruneDeferredDb,
  deleteDeferredByChat,
  pruneFeedback,
  pruneDiscovery,
  buildPreferenceSummary,
  type DeferredWrite,
  type TagPreference,
} from "../db";
import { log, debug, logError } from "../lib/logger";
import { Job, ParsedJob, jobKey } from "../types";
import { parseJobDescription, classifyBatch, quickTagJob } from "./llm";
import { normalizeForDedup, runWorkerPool } from "../lib/utils";
import { enrichJobs } from "./enrich";
import {
  UserPollStats,
  ensureStats,
  pruneInactiveStats,
  updatePollStats,
  clearPollStats,
} from "./stats";

export { RejectedJob, UserPollStats, getPollStats } from "./stats";

interface NewJob {
  job: Job;
  key: string;
  normKey: string;
}

const { MAX_NEW_PER_CYCLE, MAX_DEFER_CYCLES, DEFER_TTL_MS, USER_CONCURRENCY, PER_USER_TIMEOUT_MS } =
  POLLING;

const JOBS_LOG = path.join(process.cwd(), "logs", "jobs.jsonl");

const loggedJobs = new Set<string>();

function logNewJobs(chatId: string, jobs: NewJob[]): void {
  if (!config.debug || jobs.length === 0) return;
  const unseen = jobs.filter((nj) => {
    const logKey = `${chatId}::${nj.key}`;
    if (loggedJobs.has(logKey)) return false;
    loggedJobs.add(logKey);
    return true;
  });
  if (unseen.length === 0) return;
  const dir = path.dirname(JOBS_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const lines = unseen.map((nj) => JSON.stringify({ ...nj.job, chatId, ts }));
  fs.appendFile(JOBS_LOG, lines.join("\n") + "\n", () => {});
}

const lastPolledAt = new Map<string, number>();

export function clearUserState(chatId: string): void {
  lastPolledAt.delete(chatId);
  clearPollStats(chatId);
  clearCachedContext(chatId);
  deleteDeferredByChat(chatId);
}

let cachedJobs: Map<string, Job[]> | null = null;
let cachedAt = 0;

async function fetchAllSources(): Promise<Map<string, Job[]>> {
  if (cachedJobs && Date.now() - cachedAt < POLLING.SOURCE_CACHE_TTL_MS) {
    return cachedJobs;
  }

  const results = await Promise.allSettled(sources.map((source) => fetchWithRetry(source)));

  const jobsBySource = new Map<string, Job[]>();
  for (let i = 0; i < sources.length; i++) {
    const result = results[i];
    const source = sources[i];
    if (!result || !source) continue;
    const jobs = result.status === "fulfilled" ? result.value : [];
    jobsBySource.set(source.name, jobs);
  }

  const total = [...jobsBySource.values()].reduce((sum, jobs) => sum + jobs.length, 0);
  const summary = [...jobsBySource.entries()]
    .map(([name, jobs]) => `${name}: ${jobs.length}`)
    .join(", ");
  log(`Fetched ${total} jobs (${summary})`);

  cachedJobs = jobsBySource;
  cachedAt = Date.now();

  return jobsBySource;
}

function collectNewJobs(
  jobsBySource: Map<string, Job[]>,
  settings: UserSettings,
  chatId: string,
  ctx: ScoringContext,
): NewJob[] {
  const seenKeys = loadSeenKeys(chatId);
  const seenTitles = loadSeenTitles(chatId);
  const newJobs: NewJob[] = [];
  const cycleTitles = new Set<string>();

  for (const [sourceName, sourceJobs] of jobsBySource) {
    if (settings.enabledSources.length > 0 && !settings.enabledSources.includes(sourceName))
      continue;
    for (const original of filterJobs(sourceJobs, settings, ctx)) {
      if (!original.title.trim()) continue;
      const key = jobKey(original);
      if (seenKeys.has(key)) continue;

      const normKey = normalizeForDedup(original.title, original.company || "unknown");
      // cross-source dedup by title+company
      if (cycleTitles.has(normKey)) continue;
      if (seenTitles.has(normKey)) continue;
      cycleTitles.add(normKey);

      newJobs.push({ job: { ...original }, key, normKey });
    }
  }

  return newJobs;
}

function prioritizeForParsing(jobs: NewJob[], settings: UserSettings): NewJob[] {
  const keywords = [...settings.keywords, ...settings.roles.map((r) => r.toLowerCase())];
  if (keywords.length === 0) return jobs;

  const hasMatch = (nj: NewJob) => {
    const text = (nj.job.title + " " + nj.job.tags.join(" ")).toLowerCase();
    return keywords.some((kw) => text.includes(kw));
  };

  const high: NewJob[] = [];
  const low: NewJob[] = [];
  for (const nj of jobs) (hasMatch(nj) ? high : low).push(nj);
  return [...high, ...low];
}

async function parseJobs(
  newJobs: NewJob[],
  settings: UserSettings,
  maxParses: number,
  signal?: AbortSignal,
): Promise<Map<string, ParsedJob | null>> {
  const prioritized = prioritizeForParsing(newJobs, settings);
  debug(`Parsing ${prioritized.length} jobs for LLM (budget: ${maxParses})`);
  const parsedMap = new Map<string, ParsedJob | null>();

  const fullParseJobs = prioritized.slice(0, maxParses);
  await runWorkerPool(
    fullParseJobs,
    async ({ job, key }) => {
      if (signal?.aborted) return;
      const fullParse = await parseJobDescription(key, job.description ?? "");
      if (signal?.aborted) { parsedMap.set(key, fullParse); return; }
      parsedMap.set(key, fullParse ?? (await quickTagJob(key, job.description ?? "")));
    },
    LLM.PARSE_CONCURRENCY,
  );

  const quickTagJobs = prioritized.slice(maxParses);
  if (quickTagJobs.length > 0) {
    await runWorkerPool(
      quickTagJobs,
      async ({ job, key }) => {
        if (signal?.aborted) return;
        parsedMap.set(key, await quickTagJob(key, job.description ?? ""));
      },
      LLM.PARSE_CONCURRENCY,
    );
  }

  return parsedMap;
}

function classifyByRelevance(
  newJobs: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
  ctx: ScoringContext,
  skipHardRejects = false,
): {
  relevant: NewJob[];
  irrelevant: NewJob[];
  companyCapped: NewJob[];
  signalsMap: Map<string, string[]>;
} {
  const scores = new Map<string, number>();
  const signalsMap = new Map<string, string[]>();
  const relevant: NewJob[] = [];
  const irrelevant: NewJob[] = [];

  for (const entry of newJobs) {
    const parsed = parsedMap.get(entry.key) ?? null;
    const { score, normalized, signals } = scoreJob(entry.job, parsed, ctx, skipHardRejects);
    scores.set(entry.key, score);
    signalsMap.set(entry.key, signals);
    const pass = score >= computeThreshold(ctx);
    debug(
      `score ${score} (${normalized}%) ${pass ? "PASS" : "FAIL"} "${entry.job.title}" [${signals.join(", ")}]`,
    );
    (pass ? relevant : irrelevant).push(entry);
  }

  relevant.sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0));

  const companyCounts = new Map<string, number>();
  const capped: NewJob[] = [];
  const companyCapped: NewJob[] = [];
  for (const entry of relevant) {
    const co = entry.job.company?.toLowerCase().trim();
    if (!co) {
      capped.push(entry);
      continue;
    } // no company name → no cap
    const count = companyCounts.get(co) ?? 0;
    if (count < POLLING.MAX_PER_COMPANY) {
      companyCounts.set(co, count + 1);
      capped.push(entry);
    } else {
      companyCapped.push(entry);
    }
  }

  return { relevant: capped, irrelevant, companyCapped, signalsMap };
}

function classifyIrrelevant(
  chatId: string,
  irrelevant: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
): { markSeen: NewJob[]; deferredTotal: number } {
  const deferredMap = loadDeferredForChat(chatId);
  const ready: NewJob[] = [];
  const writes: DeferredWrite[] = [];
  const now = Date.now();

  for (const nj of irrelevant) {
    const wasParsed = parsedMap.get(nj.key) != null;

    if (wasParsed) {
      ready.push(nj);
      if (deferredMap.has(nj.key)) writes.push({ type: "delete", jobKey: nj.key });
      continue;
    }

    const prev = deferredMap.get(nj.key) ?? 0;
    const cycles = prev + 1;
    if (cycles >= MAX_DEFER_CYCLES) {
      ready.push(nj);
      writes.push({ type: "delete", jobKey: nj.key });
    } else {
      writes.push({ type: "upsert", jobKey: nj.key, cycles, updatedAt: now });
    }
  }

  if (writes.length > 0) flushDeferredBatch(chatId, writes);
  return { markSeen: ready, deferredTotal: irrelevant.length - ready.length };
}

async function deliverIndividually(
  chatId: string,
  jobs: NewJob[],
  getParsed: (nj: NewJob) => ParsedJob | null,
): Promise<NewJob[]> {
  const batch = jobs.map((nj) => ({ job: nj.job, parsed: getParsed(nj) }));
  const results = await sendJobBatch(chatId, batch);
  return jobs.filter((_, i) => results[i]);
}

async function deliverJobs(
  chatId: string,
  newJobs: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
  signalsMap: Map<string, string[]>,
  firstRun: boolean,
): Promise<NewJob[]> {
  const getParsed = (nj: NewJob) => parsedMap.get(nj.key) ?? null;

  if (firstRun) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const fresh = newJobs.filter((nj) => {
      const ts = nj.job.discoveredAt ?? new Date(nj.job.publishedAt).getTime();
      return isNaN(ts) || ts > oneDayAgo;
    });
    return deliverIndividually(chatId, fresh.slice(0, 3), getParsed);
  }

  if (newJobs.length <= 3) {
    return deliverIndividually(chatId, newJobs, getParsed);
  }

  const jobs = newJobs.map((nj) => nj.job);
  const sent = await sendJobs(chatId, jobs, parsedMap, signalsMap);
  const sentKeys = new Set(sent.map(jobKey));
  return newJobs.filter((nj) => sentKeys.has(nj.key));
}

type Preferences = { avoided: TagPreference[]; preferred: TagPreference[] } | null;

function buildUserProfile(settings: UserSettings, prefs: Preferences): string {
  const sanitize = (s: string) =>
    s
      .replace(/[\n\r]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  const profileParts: [string, string][] = [
    ["Role", sanitize(settings.roles.join(", "))],
    ["Tech", sanitize(settings.keywords.slice(0, 10).join(", "))],
    ["Level", sanitize(settings.seniority.join(", "))],
  ];
  let profile = profileParts
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join(". ");

  if (settings.excludeKeywords.length > 0) {
    profile += `. Exclude these technologies (not relevant): ${sanitize(settings.excludeKeywords.join(", "))}`;
  }
  const prefSummary = buildPreferenceSummary(settings.chatId, prefs);
  if (prefSummary) profile += `. Learned preferences: ${prefSummary}`;
  return profile;
}

async function preFilterByLLM(
  chatId: string,
  allNew: NewJob[],
  settings: UserSettings,
  prefs: Preferences,
): Promise<{ candidates: NewJob[]; preFilteredJobs: NewJob[] }> {
  const profile = buildUserProfile(settings, prefs);
  const classifyInput = allNew.map((nj, i) => ({
    index: i,
    title: nj.job.title,
    company: nj.job.company,
    tags: nj.job.tags,
  }));

  const relevantIndices = await classifyBatch(classifyInput, profile);
  const candidates = allNew.filter((_, i) => relevantIndices.has(i));
  const preFilteredJobs = allNew.filter((_, i) => !relevantIndices.has(i));

  const removed = allNew.length - candidates.length;
  if (removed > 0)
    log(`[${chatId}] LLM pre-filter: ${allNew.length} → ${candidates.length} (${removed} removed)`);
  if (candidates.length === 0) {
    markSeenBatch(
      chatId,
      allNew.map((nj) => nj.key),
    );
    const titleKeys = allNew.filter((nj) => nj.job.company).map((nj) => nj.normKey);
    if (titleKeys.length > 0) markTitleSeenBatch(chatId, titleKeys);
    log(`[${chatId}] No relevant jobs after LLM pre-filter.`);
  }

  return { candidates, preFilteredJobs };
}

function finalizeSeenState(
  chatId: string,
  stats: UserPollStats,
  delivered: NewJob[],
  markSeen: NewJob[],
  preFilteredJobs: NewJob[],
  irrelevantCount: number,
): void {
  // companyCapped stay unseen so they re-enter next cycle
  const processedJobs = [...markSeen, ...preFilteredJobs, ...delivered];
  markSeenBatch(
    chatId,
    processedJobs.map((nj) => nj.key),
  );

  if (delivered.length > 0) {
    stats.sent += delivered.length;
    incrementJobsSent(chatId, delivered.length);
  }

  const titleNormKeys = processedJobs.filter((nj) => nj.job.company).map((nj) => nj.normKey);
  if (titleNormKeys.length > 0) markTitleSeenBatch(chatId, titleNormKeys);

  log(`[${chatId}] Sent ${delivered.length} job(s), ${irrelevantCount} irrelevant.`);
}

async function processForUser(
  settings: UserSettings,
  jobsBySource: Map<string, Job[]>,
  parseBudget: number = 20,
  signal?: AbortSignal,
): Promise<void> {
  if (settings.paused) {
    log(`[${settings.chatId}] Skipped (paused).`);
    return;
  }

  const chatId = settings.chatId;
  const firstRun = isFirstRun(chatId);
  const stats = ensureStats(chatId);
  const ctx = buildScoringContext(settings);
  const feedbackPrefs = loadFeedbackIntoContext(chatId, ctx);

  const allNew = collectNewJobs(jobsBySource, settings, chatId, ctx);
  logNewJobs(chatId, allNew);
  if (allNew.length === 0) {
    log(`[${chatId}] No new jobs.`);
    return;
  }

  // Warmup / first run / backfill: mark everything seen, skip LLM.
  const isBackfill = allNew.length > MAX_NEW_PER_CYCLE * 2;
  if (firstRun || isWarmupCycle || isBackfill) {
    const bulkKeys: string[] = [];
    for (const [sourceName, sourceJobs] of jobsBySource) {
      if (settings.enabledSources.length > 0 && !settings.enabledSources.includes(sourceName))
        continue;
      for (const job of sourceJobs) bulkKeys.push(jobKey(job));
    }
    markSeenBatch(chatId, bulkKeys);

    const reason = firstRun ? "first run" : isWarmupCycle ? "warmup" : "backfill";
    log(`[${chatId}] ${reason}: marked ${bulkKeys.length} seen, ${allNew.length} new skipped (no LLM).`);
    return;
  }

  // Cap and prioritize keyword-matched jobs
  let capped = allNew;
  if (allNew.length > MAX_NEW_PER_CYCLE) {
    const prioritized = prioritizeForParsing(allNew, settings);
    const overflow = prioritized.slice(MAX_NEW_PER_CYCLE);
    capped = prioritized.slice(0, MAX_NEW_PER_CYCLE);
    markSeenBatch(
      chatId,
      overflow.map((nj) => nj.key),
    );
    log(`[${chatId}] Capped: processing ${capped.length}, skipped ${overflow.length} weak matches`);
  }

  let finalized = false;
  const companyCappedKeys = new Set<string>();
  try {
    if (signal?.aborted) return;
    const { candidates, preFilteredJobs } = await preFilterByLLM(chatId, capped, settings, feedbackPrefs);
    if (candidates.length === 0) return;

    if (signal?.aborted) return;
    const parsedMap = await parseJobs(candidates, settings, parseBudget, signal);
    const { relevant, irrelevant, companyCapped, signalsMap } = classifyByRelevance(
      candidates,
      parsedMap,
      ctx,
    );
    for (const nj of companyCapped) companyCappedKeys.add(nj.key);
    updatePollStats(
      stats,
      capped.length,
      relevant.length,
      irrelevant.map((nj) => ({
        key: nj.key,
        title: nj.job.title,
        company: nj.job.company,
        url: nj.job.url,
      })),
      signalsMap,
    );

    const { markSeen, deferredTotal } = classifyIrrelevant(chatId, irrelevant, parsedMap);
    if (irrelevant.length > 0)
      log(
        `[${chatId}] Filtered out ${irrelevant.length} irrelevant jobs via AI${deferredTotal > 0 ? ` (${deferredTotal} deferred)` : ""}`,
      );

    // Jobs without structured requirements get deferred — retry parse next cycle
    const isFullyParsed = (nj: NewJob) => {
      const p = parsedMap.get(nj.key);
      return p != null && p.requirements.length > 0;
    };
    const parsedRelevant = relevant.filter(isFullyParsed);
    const unparsedRelevant = relevant.filter((nj) => !isFullyParsed(nj));
    if (unparsedRelevant.length > 0) {
      // Don't mark seen — let them return next cycle for another parse attempt.
      // Deferred_jobs tracks cycles to prevent infinite loop (max 3 attempts).
      const now = Date.now();
      const deferWrites: DeferredWrite[] = [];
      const deferredMap = loadDeferredForChat(chatId);
      for (const nj of unparsedRelevant) {
        const prev = deferredMap.get(nj.key) ?? 0;
        if (prev + 1 >= MAX_DEFER_CYCLES) {
          // Max retries exceeded — send with raw formatting rather than lose the job
          parsedRelevant.push(nj);
          deferWrites.push({ type: "delete", jobKey: nj.key });
        } else {
          deferWrites.push({ type: "upsert", jobKey: nj.key, cycles: prev + 1, updatedAt: now });
        }
      }
      if (deferWrites.length > 0) flushDeferredBatch(chatId, deferWrites);
      log(`[${chatId}] Deferred ${unparsedRelevant.length - deferWrites.filter(w => w.type === "delete").length} unparsed relevant jobs`);
    }

    if (parsedRelevant.length === 0) {
      const allProcessed = [...markSeen, ...preFilteredJobs];
      markSeenBatch(
        chatId,
        allProcessed.map((nj) => nj.key),
      );
      const titleKeys = allProcessed.filter((nj) => nj.job.company).map((nj) => nj.normKey);
      if (titleKeys.length > 0) markTitleSeenBatch(chatId, titleKeys);
      log(`[${chatId}] No parsed relevant jobs (${candidates.length} filtered out).`);
      finalized = true;
      return;
    }

    await enrichJobs(parsedRelevant);
    const delivered = await deliverJobs(chatId, parsedRelevant, parsedMap, signalsMap, false);
    finalizeSeenState(chatId, stats, delivered, markSeen, preFilteredJobs, irrelevant.length);
    finalized = true;
  } finally {
    if (!finalized) {
      // companyCapped jobs stay unseen — they'll be delivered in a future cycle
      const interruptJobs = capped.filter((nj) => !companyCappedKeys.has(nj.key));
      markSeenBatch(
        chatId,
        interruptJobs.map((nj) => nj.key),
      );
      const titleKeys = interruptJobs.filter((nj) => nj.job.company).map((nj) => nj.normKey);
      if (titleKeys.length > 0) markTitleSeenBatch(chatId, titleKeys);
      log(
        `[${chatId}] Interrupted - marked ${interruptJobs.length} jobs as seen to prevent re-processing`,
      );
    }
  }
}

let polling = false;
let isWarmupCycle = true; // first poll cycle after process start

export function isPolling(): boolean {
  return polling;
}

export async function pollAllUsers(): Promise<void> {
  if (polling) {
    log("Poll skipped (previous cycle still running).");
    return;
  }
  polling = true;

  try {
    const active = loadOnboardedSettings();

    if (active.length === 0) {
      log("No active users.");
      return;
    }

    const now = Date.now();
    const due = active.filter((s) => {
      const last = lastPolledAt.get(s.chatId) ?? 0;
      return now - last >= s.checkIntervalMinutes * 60_000 - 30_000;
    });

    if (due.length === 0) return;

    pruneParsedCache();
    pruneCompanyUrls();
    pruneSeenTitles();
    pruneDeferredDb(Date.now() - DEFER_TTL_MS);
    pruneFeedback();
    pruneDiscovery();
    for (const s of due) pruneSeen(s.chatId);

    const activeIds = new Set(active.map((s) => s.chatId));
    pruneInactiveStats(activeIds);
    for (const id of lastPolledAt.keys()) if (!activeIds.has(id)) lastPolledAt.delete(id);

    const jobsBySource = await fetchAllSources();
    log(`Polling for ${due.length} of ${active.length} user(s)...`);

    const afterFetch = Date.now();
    const parseBudget = Math.max(10, Math.floor(LLM.PARSES_PER_HOUR / due.length));
    await runWorkerPool(
      due,
      async (settings) => {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), PER_USER_TIMEOUT_MS);
          try {
            await Promise.race([
              processForUser(settings, jobsBySource, parseBudget, ac.signal),
              new Promise<never>((_, reject) => {
                ac.signal.addEventListener("abort", () =>
                  reject(new Error(`Timed out after ${PER_USER_TIMEOUT_MS / 1000}s`)),
                );
              }),
            ]);
            lastPolledAt.set(settings.chatId, afterFetch);
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          logError(`Poll [${settings.chatId}]`, error);
        }
      },
      USER_CONCURRENCY,
    );

    log("Poll cycle complete.");
  } finally {
    isWarmupCycle = false;
    loggedJobs.clear();
    polling = false;
  }
}

export async function pollSingleUser(settings: UserSettings): Promise<void> {
  if (polling) {
    log(`[${settings.chatId}] Skipped single poll (cycle in progress).`);
    return;
  }

  polling = true;
  try {
    const jobsBySource = await fetchAllSources();
    await processForUser(settings, jobsBySource);
    lastPolledAt.set(settings.chatId, Date.now());
  } catch (error) {
    logError(`Poll [${settings.chatId}]`, error);
  } finally {
    polling = false;
  }
}
