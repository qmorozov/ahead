import { sources, fetchWithRetry } from "../sources";
import {
  filterJobs,
  buildScoringContext,
  scoreJob,
  computeThreshold,
  ScoringContext,
} from "./filter";
import { sendJob, sendJobs } from "../bot/delivery";
import { POLLING, LLM } from "../constants";
import {
  UserSettings,
  loadOnboardedSettings,
  pruneParsedCache,
  pruneCompanyUrls,
  pruneSeen,
  isSeen,
  markSeenBatch,
  isFirstRun,
  incrementJobsSent,
  isTitleSeen,
  markTitleSeenBatch,
  pruneSeenTitles,
  getDeferredCycles,
  upsertDeferred,
  deleteDeferred,
  pruneDeferredDb,
  deleteDeferredByChat,
} from "../db";
import { log, debug } from "../lib/logger";
import { logUnexpectedError } from "../lib/errors";
import { Job, ParsedJob, jobKey } from "../types";
import { parseJobDescription, classifyBatch, quickTagJob } from "./llm";
import { normalizeForDedup, sleep, runWorkerPool } from "../lib/utils";
import { enrichJobs } from "./enrich";
import { UserPollStats, getOrCreateStats, pruneInactiveStats, updatePollStats, clearPollStats } from "./stats";

export { RejectedJob, UserPollStats, getPollStats } from "./stats";

interface NewJob {
  job: Job;
  key: string;
  normKey: string;
}

const MAX_NEW_PER_CYCLE = 100;
const MAX_DEFER_CYCLES = 3;
const DEFER_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const lastPolledAt = new Map<string, number>();

/** Clear in-memory state for a user (after account deletion). */
export function clearUserState(chatId: string): void {
  lastPolledAt.delete(chatId);
  clearPollStats(chatId);
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
  const newJobs: NewJob[] = [];
  const cycleTitles = new Set<string>();

  for (const [, sourceJobs] of jobsBySource) {
    for (const original of filterJobs(sourceJobs, settings, ctx)) {
      if (!original.title.trim()) continue;
      const key = jobKey(original);
      if (isSeen(chatId, key)) continue;

      const normKey = normalizeForDedup(original.title, original.company || "unknown");
      // Within same cycle: dedup by title only (catches same job from different sources)
      const titleOnly = normKey.split("::")[0]!;
      if (cycleTitles.has(titleOnly)) continue;
      // Cross-cycle: dedup by title+company (allows same title at different companies)
      if (isTitleSeen(chatId, normKey)) continue;
      cycleTitles.add(titleOnly);

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

const PARSE_CONCURRENCY = 3;

async function parseJobs(
  newJobs: NewJob[],
  settings: UserSettings,
  maxParses: number,
): Promise<Map<string, ParsedJob | null>> {
  const prioritized = prioritizeForParsing(newJobs, settings);
  debug(`Parsing ${prioritized.length} jobs for LLM (budget: ${maxParses})`);
  const parsedMap = new Map<string, ParsedJob | null>();

  // Phase 1: full parses - fall back to quick-tag if heavy model fails
  const fullParseJobs = prioritized.slice(0, maxParses);
  await runWorkerPool(
    fullParseJobs,
    async ({ job, key }) => {
      const result = await parseJobDescription(key, job.description ?? "");
      parsedMap.set(key, result ?? (await quickTagJob(key, job.description ?? "")));
    },
    PARSE_CONCURRENCY,
  );

  // Phase 2: quick-tags for overflow jobs beyond the heavy-parse budget
  const quickTagJobs = prioritized.slice(maxParses);
  if (quickTagJobs.length > 0) {
    await runWorkerPool(
      quickTagJobs,
      async ({ job, key }) => {
        parsedMap.set(key, await quickTagJob(key, job.description ?? ""));
      },
      PARSE_CONCURRENCY,
    );
  }

  return parsedMap;
}

function classifyByRelevance(
  newJobs: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
  ctx: ScoringContext,
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
    const result = scoreJob(entry.job, parsed, ctx);
    scores.set(entry.key, result.score);
    signalsMap.set(entry.key, result.signals);
    const pass = result.score >= computeThreshold(ctx);
    debug(
      `score ${result.score} (${result.normalized}%) ${pass ? "PASS" : "FAIL"} "${entry.job.title}" [${result.signals.join(", ")}]`,
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

/** Split irrelevant jobs into those ready to mark seen vs deferred for re-evaluation. */
function classifyIrrelevant(
  chatId: string,
  irrelevant: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
): { markSeen: NewJob[]; deferredTotal: number } {
  const ready: NewJob[] = [];
  for (const nj of irrelevant) {
    const wasParsed = parsedMap.get(nj.key) != null;

    if (wasParsed) {
      ready.push(nj);
      deleteDeferred(chatId, nj.key);
      continue;
    }

    const prev = getDeferredCycles(chatId, nj.key);
    const cycles = (prev ?? 0) + 1;
    if (cycles >= MAX_DEFER_CYCLES) {
      ready.push(nj);
      deleteDeferred(chatId, nj.key);
    } else {
      upsertDeferred(chatId, nj.key, cycles, Date.now());
    }
  }
  return { markSeen: ready, deferredTotal: irrelevant.length - ready.length };
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
      const ts = new Date(nj.job.publishedAt).getTime();
      return isNaN(ts) || ts > oneDayAgo;
    });
    const top = fresh.slice(0, 3);
    if (top.length === 0) return [];

    const delivered: NewJob[] = [];
    for (const nj of top) {
      if (await sendJob(chatId, nj.job, getParsed(nj))) delivered.push(nj);
    }
    return delivered;
  }

  if (newJobs.length <= 3) {
    const delivered: NewJob[] = [];
    for (const nj of newJobs) {
      if (await sendJob(chatId, nj.job, getParsed(nj))) delivered.push(nj);
    }
    return delivered;
  }

  const jobs = newJobs.map((nj) => nj.job);
  const sent = await sendJobs(chatId, jobs, parsedMap, signalsMap);
  const sentKeys = new Set(sent.map(jobKey));
  const delivered = newJobs.filter((nj) => sentKeys.has(nj.key));
  return delivered;
}

/** Build a sanitized profile string for LLM classify from user settings. */
function buildUserProfile(settings: UserSettings): string {
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
  return profile;
}

/**
 * Run LLM pre-filter on new jobs. Returns candidates that passed and jobs that were filtered out.
 * Side effect: logs pre-filter stats. Marks all jobs seen if none pass.
 */
async function preFilterByLLM(
  chatId: string,
  allNew: NewJob[],
  settings: UserSettings,
): Promise<{ candidates: NewJob[]; preFilteredJobs: NewJob[] }> {
  const profile = buildUserProfile(settings);
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
    log(`[${chatId}] No relevant jobs after LLM pre-filter.`);
  }

  return { candidates, preFilteredJobs };
}

/**
 * Mark all processed jobs as seen, record delivered count, and mark title dedup keys.
 * Side effects: writes to seen_jobs, seen_titles, and settings tables.
 */
function finalizeSeenState(
  chatId: string,
  stats: UserPollStats,
  firstRun: boolean,
  delivered: NewJob[],
  markSeen: NewJob[],
  companyCapped: NewJob[],
  preFilteredJobs: NewJob[],
  irrelevantCount: number,
): void {
  const processedJobs = [...markSeen, ...companyCapped, ...preFilteredJobs, ...delivered];
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

  log(
    `[${chatId}] ${firstRun ? "First run: " : ""}Sent ${delivered.length} job(s), ${irrelevantCount} irrelevant.`,
  );
}

/**
 * Pipeline orchestrator - runs the full job processing pipeline for a single user.
 *
 * This function is intentionally centralized. Each pipeline step is delegated to a
 * focused function, but the step ordering and data flow between them must live in one
 * place so the full sequence is visible and debuggable.
 *
 * Steps:
 *  1. collectNewJobs     - pre-filter by keyword/location/salary/age, dedup against seen_jobs
 *  2. preFilterByLLM     - lightweight LLM classify to remove obviously irrelevant jobs
 *  3. parseJobs          - full LLM parse (or quick-tag fallback) for surviving candidates
 *  4. classifyByRelevance - run 12 scorers, apply threshold, cap per-company count
 *  5. classifyIrrelevant  - defer unparsed rejects for re-evaluation, finalize parsed rejects
 *  6. enrichJobs         - resolve company URLs (Clearbit) and Djinni metadata
 *  7. deliverJobs        - send individual messages or paginated digest via Telegram
 *  8. finalizeSeenState  - mark all processed jobs as seen, update stats and counters
 */
async function processForUser(
  settings: UserSettings,
  jobsBySource: Map<string, Job[]>,
  parseBudget: number = 20,
): Promise<void> {
  if (settings.paused) {
    log(`[${settings.chatId}] Skipped (paused).`);
    return;
  }

  const chatId = settings.chatId;
  const firstRun = isFirstRun(chatId);
  const stats = getOrCreateStats(chatId);
  const ctx = buildScoringContext(settings);

  let allNew = collectNewJobs(jobsBySource, settings, chatId, ctx);
  if (allNew.length === 0) {
    log(`[${chatId}] No new jobs.`);
    return;
  }

  // Cap to prevent timeout - prioritize title/tag matches over description-only
  if (allNew.length > MAX_NEW_PER_CYCLE) {
    const prioritized = prioritizeForParsing(allNew, settings);
    const overflow = prioritized.slice(MAX_NEW_PER_CYCLE);
    allNew = prioritized.slice(0, MAX_NEW_PER_CYCLE);
    markSeenBatch(
      chatId,
      overflow.map((nj) => nj.key),
    );
    log(`[${chatId}] Capped: processing ${allNew.length}, skipped ${overflow.length} weak matches`);
  }

  let finalized = false;
  try {
    const { candidates, preFilteredJobs } = await preFilterByLLM(chatId, allNew, settings);
    if (candidates.length === 0) return;

    const parsedMap = await parseJobs(candidates, settings, parseBudget);
    const { relevant, irrelevant, companyCapped, signalsMap } = classifyByRelevance(
      candidates,
      parsedMap,
      ctx,
    );
    updatePollStats(
      stats,
      allNew.length,
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

    if (relevant.length === 0) {
      markSeenBatch(
        chatId,
        [...markSeen, ...companyCapped, ...preFilteredJobs].map((nj) => nj.key),
      );
      log(`[${chatId}] No relevant jobs (${candidates.length} filtered out).`);
      finalized = true;
      return;
    }

    await enrichJobs(relevant);
    const delivered = await deliverJobs(chatId, relevant, parsedMap, signalsMap, firstRun);
    finalizeSeenState(
      chatId,
      stats,
      firstRun,
      delivered,
      markSeen,
      companyCapped,
      preFilteredJobs,
      irrelevant.length,
    );
    finalized = true;
  } finally {
    // Safety net: if interrupted (timeout, error) before finalization,
    // mark all jobs seen to prevent re-processing loop
    if (!finalized) {
      markSeenBatch(
        chatId,
        allNew.map((nj) => nj.key),
      );
      log(
        `[${chatId}] Interrupted - marked ${allNew.length} jobs as seen to prevent re-processing`,
      );
    }
  }
}

let polling = false;

/** Returns true if a poll cycle is currently in progress. Used for overlap prevention and shutdown. */
export function isPolling(): boolean {
  return polling;
}

/** Run a poll cycle for all due users. Skips if already polling (overlap guard). */
export async function pollAllUsers(): Promise<void> {
  if (polling) return;
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
    for (const s of due) pruneSeen(s.chatId);

    const activeIds = new Set(active.map((s) => s.chatId));
    pruneInactiveStats(activeIds);
    for (const id of lastPolledAt.keys()) if (!activeIds.has(id)) lastPolledAt.delete(id);

    const jobsBySource = await fetchAllSources();
    log(`Polling for ${due.length} of ${active.length} user(s)...`);

    const afterFetch = Date.now();
    const parseBudget = Math.max(10, Math.floor(LLM.PARSES_PER_HOUR / due.length));
    const USER_CONCURRENCY = 3;
    const PER_USER_TIMEOUT_MS = 180_000;

    await runWorkerPool(
      due,
      async (settings) => {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), PER_USER_TIMEOUT_MS);
          try {
            await Promise.race([
              processForUser(settings, jobsBySource, parseBudget),
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
          logUnexpectedError(`Poll [${settings.chatId}]`, error);
        }
      },
      USER_CONCURRENCY,
    );

    log("Poll cycle complete.");
  } finally {
    polling = false;
  }
}

/** Run a one-off poll for a single user (e.g. right after onboarding). */
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
    logUnexpectedError(`Poll [${settings.chatId}]`, error);
  } finally {
    polling = false;
  }
}
