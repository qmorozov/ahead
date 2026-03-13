import { sources, fetchWithRetry } from "./sources";
import { filterJobs, buildTagSet, isRelevantByTags, matchesSeniority } from "./filter";
import { sendJob, sendJobs } from "./bot";
import {
  isOnboarded,
  UserSettings,
  loadAllSettings,
  pruneParsedCache,
  pruneSeen,
  jobKey,
  isSeen,
  markSeen,
  markSeenBatch,
  isFirstRun,
  incrementJobsSent,
} from "./db";
import { log, logError } from "./logger";
import { Job, ParsedJob } from "./types";
import { parseJobDescription } from "./llm";
import { enrichJob } from "./sources/djinni";

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
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
    const result = results[i]!;
    const jobs = result.status === "fulfilled" ? result.value : [];
    jobsBySource.set(sources[i]!.name, jobs);
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

async function processForUser(
  settings: UserSettings,
  jobsBySource: Map<string, Job[]>,
): Promise<void> {
  if (settings.paused) {
    log(`[${settings.chatId}] Skipped (paused).`);
    return;
  }

  const chatId = settings.chatId;
  const firstRun = isFirstRun(chatId);

  const allJobs: Job[] = [];
  const keyOf = new Map<Job, string>();

  for (const [, jobs] of jobsBySource) {
    const filtered = filterJobs(jobs, settings);
    for (const job of filtered) {
      const key = jobKey(job);
      if (!isSeen(chatId, key)) {
        allJobs.push(job);
        keyOf.set(job, key);
      }
    }
  }

  const parsedMap = new Map<string, ParsedJob | null>();

  for (const job of allJobs) {
    const key = keyOf.get(job)!;
    const parsed = await parseJobDescription(key, job.description ?? "");
    parsedMap.set(key, parsed);
  }

  const relevantJobs: Job[] = [];
  const irrelevant: Job[] = [];
  const tagSet = buildTagSet(settings.keywords);
  const senioritySet = new Set(settings.seniority.map((s) => s.toLowerCase()));

  for (const job of allJobs) {
    const parsed = parsedMap.get(keyOf.get(job)!) ?? null;
    if (!isRelevantByTags(parsed, tagSet, settings.keywords.length)) {
      irrelevant.push(job);
    } else if (!matchesSeniority(job.title, parsed, senioritySet)) {
      irrelevant.push(job);
    } else {
      relevantJobs.push(job);
    }
  }

  if (irrelevant.length > 0) {
    log(`[${chatId}] Filtered out ${irrelevant.length} irrelevant jobs via AI`);
  }

  const toEnrich = relevantJobs.filter((j) => j.source === "Djinni" && (!j.company || !j.location));
  for (let i = 0; i < toEnrich.length; i += 5) {
    await Promise.all(toEnrich.slice(i, i + 5).map((job) => enrichJob(job)));
  }

  let sentCount = 0;

  if (allJobs.length === 0) {
    log(`[${chatId}] No new jobs.`);
  } else if (relevantJobs.length === 0) {
    markSeenBatch(chatId, allJobs.map((j) => keyOf.get(j)!));
    log(`[${chatId}] No relevant jobs (${allJobs.length} filtered out).`);
  } else if (firstRun) {
    const sorted = [...relevantJobs].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );
    const newest = sorted[0]!;
    const rest = sorted.slice(1);
    const newestKey = keyOf.get(newest)!;
    await sendJob(chatId, newest, parsedMap.get(newestKey) ?? null);
    markSeen(chatId, newestKey);
    markSeenBatch(chatId, rest.map((j) => keyOf.get(j)!));
    sentCount = 1;
    log(`[${chatId}] First run: sent 1 newest, marked ${rest.length} skipped, ${irrelevant.length} irrelevant.`);
  } else if (relevantJobs.length <= 3) {
    for (const job of relevantJobs) {
      await sendJob(chatId, job, parsedMap.get(keyOf.get(job)!) ?? null);
    }
    markSeenBatch(chatId, relevantJobs.map((j) => keyOf.get(j)!));
    sentCount = relevantJobs.length;
    log(`[${chatId}] Sent ${relevantJobs.length} job(s).`);
  } else {
    const sent = await sendJobs(chatId, relevantJobs, parsedMap);
    markSeenBatch(chatId, sent.map((j) => keyOf.get(j)!));
    sentCount = sent.length;
    log(`[${chatId}] Sent digest: ${sent.length} jobs.`);
  }

  if (sentCount > 0 && irrelevant.length > 0) {
    markSeenBatch(chatId, irrelevant.map((j) => keyOf.get(j)!));
  }

  if (sentCount > 0) {
    incrementJobsSent(chatId, sentCount);
  }
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
    for (const s of due) pruneSeen(s.chatId);

    const jobsBySource = await fetchAllSources();
    log(`Polling for ${due.length} of ${active.length} user(s)...`);

    for (const settings of due) {
      try {
        await processForUser(settings, jobsBySource);
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
  const jobsBySource = await fetchAllSources();
  await processForUser(settings, jobsBySource);
  lastPolledAt.set(settings.chatId, Date.now());
}
