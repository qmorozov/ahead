import { sources, fetchWithRetry } from "./sources";
import { filterJobs, buildScoringContext, scoreJob } from "./filter";
import { sendJob, sendJobs } from "./delivery";
import {
  isOnboarded,
  UserSettings,
  loadAllSettings,
  pruneParsedCache,
  pruneCompanyUrls,
  pruneSeen,
  isSeen,
  markSeenBatch,
  isFirstRun,
  incrementJobsSent,
  isTitleSeen,
  markTitleSeen,
  pruneSeenTitles,
} from "./db";
import { log, debug, logError } from "./logger";
import { Job, ParsedJob, jobKey } from "./types";
import { parseJobDescription, classifyBatch } from "./llm";
import { fetchDjinniEnrichment } from "./sources/djinni";
import { resolveCompanyUrls } from "./company";
import { normalizeForDedup } from "./utils";

interface NewJob {
  job: Job;
  key: string;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
let cachedJobs: Map<string, Job[]> | null = null;
let cachedAt = 0;

const lastPolledAt = new Map<string, number>();

async function fetchAllSources(): Promise<Map<string, Job[]>> {
  if (cachedJobs && Date.now() - cachedAt < CACHE_TTL_MS) {
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
  chatId: string,
  jobsBySource: Map<string, Job[]>,
  settings: UserSettings,
): NewJob[] {
  const newJobs: NewJob[] = [];
  const seenTitles = new Set<string>();

  for (const [, sourceJobs] of jobsBySource) {
    for (const original of filterJobs(sourceJobs, settings)) {
      const key = jobKey(original);
      if (isSeen(chatId, key)) continue;

      if (original.company) {
        const normKey = normalizeForDedup(original.title, original.company);
        if (seenTitles.has(normKey) || isTitleSeen(chatId, normKey)) continue;
        seenTitles.add(normKey);
      }

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
      parsedMap.set(key, null);
      continue;
    }
    const result = await parseJobDescription(key, job.description ?? "");
    parsedMap.set(key, result);
    if (result !== null) parsed++;
  }
  return parsedMap;
}

const MAX_PER_COMPANY = 3;

function classifyByRelevance(
  newJobs: NewJob[],
  parsedMap: Map<string, ParsedJob | null>,
  settings: UserSettings,
): { relevant: NewJob[]; irrelevant: NewJob[]; signalsMap: Map<string, string[]> } {
  const ctx = buildScoringContext(settings);
  const scores = new Map<string, number>();
  const signalsMap = new Map<string, string[]>();
  const relevant: NewJob[] = [];
  const irrelevant: NewJob[] = [];

  for (const entry of newJobs) {
    const parsed = parsedMap.get(entry.key) ?? null;
    const { score, signals } = scoreJob(entry.job, parsed, ctx);
    scores.set(entry.key, score);
    signalsMap.set(entry.key, signals);
    const threshold = parsed ? 20 : 15;
    const pass = score >= threshold;
    debug(`score ${score}/${threshold} ${pass ? "PASS" : "FAIL"} "${entry.job.title}" [${signals.join(", ")}]`);
    (pass ? relevant : irrelevant).push(entry);
  }

  relevant.sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0));

  const companyCounts = new Map<string, number>();
  const capped: NewJob[] = [];
  const overflow: NewJob[] = [];
  for (const entry of relevant) {
    const co = entry.job.company.toLowerCase().trim();
    const count = companyCounts.get(co) ?? 0;
    if (count < MAX_PER_COMPANY) {
      companyCounts.set(co, count + 1);
      capped.push(entry);
    } else {
      overflow.push(entry);
    }
  }

  return { relevant: capped, irrelevant: [...irrelevant, ...overflow], signalsMap };
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
): Promise<{ delivered: NewJob[]; skipped: NewJob[] }> {
  const getParsed = (nj: NewJob) => parsedMap.get(nj.key) ?? null;

  if (firstRun) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const fresh = newJobs.filter((nj) => new Date(nj.job.publishedAt).getTime() > dayAgo);
    const newest = fresh[0];
    if (!newest) return { delivered: [], skipped: newJobs };

    const ok = await sendJob(chatId, newest.job, getParsed(newest));
    return { delivered: ok ? [newest] : [], skipped: newJobs.filter((nj) => nj !== newest) };
  }

  if (newJobs.length <= 3) {
    const delivered: NewJob[] = [];
    for (const nj of newJobs) {
      if (await sendJob(chatId, nj.job, getParsed(nj))) delivered.push(nj);
    }
    return { delivered, skipped: [] };
  }

  const jobs = newJobs.map((nj) => nj.job);
  const sent = await sendJobs(chatId, jobs, parsedMap, signalsMap);
  const sentKeys = new Set(sent.map(jobKey));
  const delivered = newJobs.filter((nj) => sentKeys.has(nj.key));
  return { delivered, skipped: [] };
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

  const allNew = collectNewJobs(chatId, jobsBySource, settings);
  if (allNew.length === 0) {
    log(`[${chatId}] No new jobs.`);
    return;
  }

  const profile = [
    settings.roles.length > 0 ? `Role: ${settings.roles.join(", ")}` : "",
    settings.keywords.length > 0 ? `Tech: ${settings.keywords.slice(0, 10).join(", ")}` : "",
    settings.seniority.length > 0 ? `Level: ${settings.seniority.join(", ")}` : "",
    settings.excludeKeywords.length > 0 ? `Exclude: ${settings.excludeKeywords.join(", ")}` : "",
  ].filter(Boolean).join(". ");

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

  const { relevant, irrelevant, signalsMap } = classifyByRelevance(newJobs, parsedMap, settings);
  if (irrelevant.length > 0) {
    log(`[${chatId}] Filtered out ${irrelevant.length} irrelevant jobs via AI`);
  }

  if (relevant.length === 0) {
    markSeenBatch(
      chatId,
      irrelevant.map((nj) => nj.key),
    );
    log(`[${chatId}] No relevant jobs (${newJobs.length} filtered out).`);
    return;
  }

  await enrichJobs(relevant);

  const { delivered, skipped } = await deliverJobs(
    chatId,
    relevant,
    parsedMap,
    signalsMap,
    firstRun,
  );

  if (skipped.length > 0) {
    markSeenBatch(
      chatId,
      skipped.map((nj) => nj.key),
    );
  }
  if (delivered.length > 0) {
    markSeenBatch(
      chatId,
      delivered.map((nj) => nj.key),
    );
    markSeenBatch(
      chatId,
      irrelevant.map((nj) => nj.key),
    );
    const preFilteredJobs = allNew.filter((_, i) => !relevantIndices.has(i));
    markSeenBatch(chatId, preFilteredJobs.map((nj) => nj.key));
    for (const nj of [...delivered, ...irrelevant, ...skipped, ...preFilteredJobs]) {
      if (nj.job.company) markTitleSeen(chatId, normalizeForDedup(nj.job.title, nj.job.company));
    }
    incrementJobsSent(chatId, delivered.length);
  }

  log(
    `[${chatId}] ${firstRun ? "First run: " : ""}Sent ${delivered.length} job(s), ${skipped.length} skipped, ${irrelevant.length} irrelevant.`,
  );
}

let polling = false;

export async function pollAllUsers(): Promise<void> {
  if (polling) return;
  polling = true;

  try {
    const allSettings = loadAllSettings();
    const active = allSettings.filter((s) => isOnboarded(s));

    if (active.length === 0) {
      log("No active users.");
      return;
    }

    const now = Date.now();
    const due = active.filter((s) => {
      const last = lastPolledAt.get(s.chatId) ?? 0;
      return now - last >= s.checkIntervalMinutes * 60_000;
    });

    if (due.length === 0) return;

    pruneParsedCache();
    pruneCompanyUrls();
    pruneSeenTitles();
    for (const s of due) pruneSeen(s.chatId);

    const jobsBySource = await fetchAllSources();
    log(`Polling for ${due.length} of ${active.length} user(s)...`);

    const parseBudget = Math.max(10, Math.floor(40 / due.length));
    for (const settings of due) {
      try {
        await processForUser(settings, jobsBySource, parseBudget);
        lastPolledAt.set(settings.chatId, now);
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
