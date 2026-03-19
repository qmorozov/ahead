import { sources, fetchWithRetry } from "../sources";
import { filterJobs, buildScoringContext, scoreJob, computeThreshold, ScoringContext } from "./filter";
import { sendJob, sendJobs } from "../bot/delivery";
import { POLLING, LLM } from "../constants";
import {
  isOnboarded,
  UserSettings,
  loadAllSettings,
  pruneParsedCache,
  pruneCompanyUrls,
  pruneSeen,
  loadSeenKeys,
  markSeenBatch,
  isFirstRun,
  incrementJobsSent,
  loadSeenTitles,
  markTitleSeen,
  pruneSeenTitles,
  loadDeferredJobs,
  upsertDeferred,
  deleteDeferred,
  pruneDeferredDb,
  deleteDeferredByChat,
} from "../db";
import { log, debug, logError } from "../lib/logger";
import { Job, ParsedJob, jobKey } from "../types";
import { parseJobDescription, classifyBatch, quickTagJob } from "./llm";
import { fetchDjinniEnrichment } from "../sources/djinni";
import { resolveCompanyUrls } from "./company";
import { normalizeForDedup, sleep } from "../lib/utils";

interface NewJob {
  job: Job;
  key: string;
}

export interface RejectedJob {
  title: string;
  company: string;
  url: string;
  reason: string;
}

export interface UserPollStats {
  checked: number;
  passed: number;
  sent: number;
  rejected: RejectedJob[];
}

const pollStats = new Map<string, UserPollStats>();
const MAX_REJECTED = 10;

export function getPollStats(chatId: string): UserPollStats | undefined {
  return pollStats.get(chatId);
}

export function clearUserState(chatId: string): void {
  pollStats.delete(chatId);
  lastPolledAt.delete(chatId);
  for (const key of deferredCount.keys()) {
    if (key.startsWith(`${chatId}::`)) deferredCount.delete(key);
  }
  deleteDeferredByChat(chatId);
}

let cachedJobs: Map<string, Job[]> | null = null;
let cachedAt = 0;

const lastPolledAt = new Map<string, number>();
let deferredCount = new Map<string, { cycles: number; updatedAt: number }>(); // chatId::jobKey -> state
let deferredLoaded = false;
const MAX_DEFER_CYCLES = 3;
const DEFER_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function ensureDeferredLoaded(): void {
  if (deferredLoaded) return;
  const cutoff = Date.now() - DEFER_TTL_MS;
  deferredCount = loadDeferredJobs(cutoff);
  deferredLoaded = true;
}

function pruneDeferredCount(): void {
  const cutoff = Date.now() - DEFER_TTL_MS;
  for (const [key, entry] of deferredCount) {
    if (entry.updatedAt < cutoff) deferredCount.delete(key);
  }
  pruneDeferredDb(cutoff);
}

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
  seenKeys: Set<string>,
  seenTitleKeys: Set<string>,
  ctx: ScoringContext,
): NewJob[] {
  const newJobs: NewJob[] = [];
  const cycleTitles = new Set<string>();

  for (const [, sourceJobs] of jobsBySource) {
    for (const original of filterJobs(sourceJobs, settings, ctx)) {
      if (!original.title.trim()) continue;
      const key = jobKey(original);
      if (seenKeys.has(key)) continue;

      const normKey = normalizeForDedup(original.title, original.company || "unknown");
      // Within same cycle: dedup by title only (catches same job from different sources)
      const titleOnly = normKey.split("::")[0]!;
      if (cycleTitles.has(titleOnly)) continue;
      // Cross-cycle: dedup by title+company (allows same title at different companies)
      if (seenTitleKeys.has(normKey)) continue;
      cycleTitles.add(titleOnly);

      newJobs.push({ job: { ...original }, key });
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

async function parseJobs(newJobs: NewJob[], settings: UserSettings, maxParses: number): Promise<Map<string, ParsedJob | null>> {
  const prioritized = prioritizeForParsing(newJobs, settings);
  debug(`Parsing ${prioritized.length} jobs for LLM (budget: ${maxParses})`);
  const parsedMap = new Map<string, ParsedJob | null>();
  let parsed = 0;
  for (const { job, key } of prioritized) {
    if (parsed >= maxParses) {
      // Quick-tag with 8B model for jobs that exceed full parse budget
      const quickResult = await quickTagJob(key, job.description ?? "");
      parsedMap.set(key, quickResult);
      continue;
    }
    const result = await parseJobDescription(key, job.description ?? "");
    if (result !== null) {
      parsedMap.set(key, result);
      parsed++;
    } else {
      // Full parse unavailable (quota/error) — fall back to quick-tag for better scoring
      const quickResult = await quickTagJob(key, job.description ?? "");
      parsedMap.set(key, quickResult);
    }
  }
  return parsedMap;
}

function classifyByRelevance(
  newJobs: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
  ctx: ScoringContext,
): { relevant: NewJob[]; irrelevant: NewJob[]; companyCapped: NewJob[]; signalsMap: Map<string, string[]> } {
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
    debug(`score ${result.score} (${result.normalized}%) ${pass ? "PASS" : "FAIL"} "${entry.job.title}" [${result.signals.join(", ")}]`);
    (pass ? relevant : irrelevant).push(entry);
  }

  relevant.sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0));

  const companyCounts = new Map<string, number>();
  const capped: NewJob[] = [];
  const companyCapped: NewJob[] = [];
  for (const entry of relevant) {
    const co = entry.job.company?.toLowerCase().trim();
    if (!co) { capped.push(entry); continue; } // no company name → no cap
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
    const deferKey = `${chatId}::${nj.key}`;
    const wasParsed = parsedMap.get(nj.key) != null;

    if (wasParsed) {
      ready.push(nj);
      deferredCount.delete(deferKey);
      deleteDeferred(chatId, nj.key);
      continue;
    }

    const prev = deferredCount.get(deferKey);
    const cycles = (prev?.cycles ?? 0) + 1;
    if (cycles >= MAX_DEFER_CYCLES) {
      ready.push(nj);
      deferredCount.delete(deferKey);
      deleteDeferred(chatId, nj.key);
    } else {
      const now = Date.now();
      deferredCount.set(deferKey, { cycles, updatedAt: now });
      upsertDeferred(chatId, nj.key, cycles, now);
    }
  }
  return { markSeen: ready, deferredTotal: irrelevant.length - ready.length };
}

async function enrichJobs(newJobs: NewJob[]): Promise<void> {
  const djinniJobs = newJobs.filter(
    (nj) => nj.job.source === "Djinni" && (!nj.job.company || !nj.job.location),
  );
  for (let i = 0; i < djinniJobs.length; i += 5) {
    const batch = djinniJobs.slice(i, i + 5);
    const results = await Promise.all(batch.map((nj) => fetchDjinniEnrichment(nj.job.url)));
    for (let j = 0; j < batch.length; j++) {
      const enriched = results[j];
      const nj = batch[j];
      if (!enriched || !nj) continue;
      if (!nj.job.company && enriched.company) nj.job.company = enriched.company;
      if (!nj.job.location && enriched.location) nj.job.location = enriched.location;
    }
    if (i + 5 < djinniJobs.length) await sleep(2000);
  }

  const jobs = newJobs.map((nj) => nj.job);
  const companyUrls = await resolveCompanyUrls(jobs);
  for (const { job } of newJobs) {
    if (!job.companyUrl && job.company) {
      const url = companyUrls.get(job.company.toLowerCase().trim());
      if (url) job.companyUrl = url;
    }
  }
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
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const fresh = newJobs.filter((nj) => {
      const ts = new Date(nj.job.publishedAt).getTime();
      return isNaN(ts) || ts > sixHoursAgo;
    });
    const top = fresh.slice(0, 3);
    if (top.length === 0) return [];

    const delivered: NewJob[] = [];
    for (const nj of top) {
      if (await sendJob(chatId, nj.job, getParsed(nj))) delivered.push(nj);
    }
    // Don't mark remaining as skipped — they'll appear in next cycle
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
  const stats: UserPollStats = pollStats.get(chatId) ?? { checked: 0, passed: 0, sent: 0, rejected: [] };
  pollStats.set(chatId, stats);

  const ctx = buildScoringContext(settings);
  const seenKeys = loadSeenKeys(chatId);
  const seenTitleKeys = loadSeenTitles(chatId);
  const allNew = collectNewJobs(jobsBySource, settings, seenKeys, seenTitleKeys, ctx);
  if (allNew.length === 0) {
    log(`[${chatId}] No new jobs.`);
    return;
  }

  // Sanitize user settings to prevent prompt injection
  const sanitize = (s: string) => s.replace(/[\n\r]/g, " ").replace(/\s{2,}/g, " ").trim();
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

  const classifyInput = allNew.map((nj, i) => ({
    index: i,
    title: nj.job.title,
    company: nj.job.company,
    tags: nj.job.tags,
  }));

  const relevantIndices = await classifyBatch(classifyInput, profile);
  const newJobs = allNew.filter((_, i) => relevantIndices.has(i));
  const preFiltered = allNew.length - newJobs.length;

  if (preFiltered > 0) log(`[${chatId}] LLM pre-filter: ${allNew.length} → ${newJobs.length} (${preFiltered} removed)`);
  if (newJobs.length === 0) {
    markSeenBatch(chatId, allNew.map((nj) => nj.key));
    log(`[${chatId}] No relevant jobs after LLM pre-filter.`);
    return;
  }

  const parsedMap = await parseJobs(newJobs, settings, parseBudget);

  const { relevant, irrelevant, companyCapped, signalsMap } = classifyByRelevance(newJobs, parsedMap, ctx);

  stats.checked += allNew.length;
  stats.passed += relevant.length;
  for (const nj of irrelevant) {
    const reasons = signalsMap.get(nj.key) ?? [];
    stats.rejected.push({
      title: nj.job.title,
      company: nj.job.company,
      url: nj.job.url,
      reason: reasons[0] ?? "low score",
    });
  }
  if (stats.rejected.length > MAX_REJECTED) {
    stats.rejected = stats.rejected.slice(-MAX_REJECTED);
  }

  const { markSeen, deferredTotal: deferred } = classifyIrrelevant(chatId, irrelevant, parsedMap);

  if (irrelevant.length > 0) {
    log(`[${chatId}] Filtered out ${irrelevant.length} irrelevant jobs via AI${deferred > 0 ? ` (${deferred} deferred)` : ""}`);
  }

  const preFilteredJobs = allNew.filter((_, i) => !relevantIndices.has(i));

  if (relevant.length === 0) {
    markSeenBatch(chatId, [...markSeen, ...companyCapped, ...preFilteredJobs].map((nj) => nj.key));
    log(`[${chatId}] No relevant jobs (${newJobs.length} filtered out).`);
    return;
  }

  await enrichJobs(relevant);

  const delivered = await deliverJobs(
    chatId,
    relevant,
    parsedMap,
    signalsMap,
    firstRun,
  );

  // Consolidate all processed jobs and mark as seen in one batch.
  // companyCapped are relevant but exceeded per-company limit — mark seen to avoid re-appearing.
  const processedJobs = [...markSeen, ...companyCapped, ...preFilteredJobs, ...delivered];
  markSeenBatch(chatId, processedJobs.map((nj) => nj.key));

  if (delivered.length > 0) {
    stats.sent += delivered.length;
    incrementJobsSent(chatId, delivered.length);
  }

  for (const nj of processedJobs) {
    if (nj.job.company) markTitleSeen(chatId, normalizeForDedup(nj.job.title, nj.job.company));
  }

  log(
    `[${chatId}] ${firstRun ? "First run: " : ""}Sent ${delivered.length} job(s), ${irrelevant.length} irrelevant.`,
  );
}

let polling = false;

export function isPolling(): boolean {
  return polling;
}

export async function pollAllUsers(): Promise<void> {
  if (polling) return;
  polling = true;

  try {
    ensureDeferredLoaded();
    const allSettings = loadAllSettings();
    const active = allSettings.filter((s) => isOnboarded(s));

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
    pruneDeferredCount();
    for (const s of due) pruneSeen(s.chatId);

    const jobsBySource = await fetchAllSources();
    log(`Polling for ${due.length} of ${active.length} user(s)...`);

    const afterFetch = Date.now();
    const parseBudget = Math.max(10, Math.floor(LLM.PARSES_PER_HOUR / due.length));
    for (const settings of due) {
      try {
        await processForUser(settings, jobsBySource, parseBudget);
        lastPolledAt.set(settings.chatId, afterFetch);
      } catch (error) {
        logError(`Poll [${settings.chatId}]`, error);
      }
    }

    log("Poll cycle complete.");
  } finally {
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
