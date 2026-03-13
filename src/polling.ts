import { sources, fetchWithRetry } from "./sources";
import { filterJobs, isRelevantByTags } from "./filter";
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
} from "./db";
import { log, logError } from "./logger";
import { Job, ParsedJob } from "./types";
import { parseJobDescription } from "./llm";

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

  for (const [, jobs] of jobsBySource) {
    const filtered = filterJobs(jobs, settings);
    const newJobs = filtered.filter((job) => !isSeen(chatId, jobKey(job)));
    allJobs.push(...newJobs);
  }

  const parsedMap = new Map<string, ParsedJob | null>();

  for (const job of allJobs) {
    const key = jobKey(job);
    const parsed = await parseJobDescription(key, job.description ?? "");
    parsedMap.set(key, parsed);
  }

  const relevantJobs: Job[] = [];
  const irrelevant: Job[] = [];

  for (const job of allJobs) {
    const parsed = parsedMap.get(jobKey(job)) ?? null;
    if (!isRelevantByTags(parsed, settings.keywords)) {
      irrelevant.push(job);
    } else {
      relevantJobs.push(job);
    }
  }

  if (irrelevant.length > 0) {
    log(`[${chatId}] Filtered out ${irrelevant.length} irrelevant jobs via AI`);
  }

  if (firstRun && relevantJobs.length > 0) {
    const sorted = [...relevantJobs].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );
    const newest = sorted[0]!;
    const rest = sorted.slice(1);
    await sendJob(chatId, newest, parsedMap.get(jobKey(newest)) ?? null);
    markSeen(chatId, jobKey(newest));
    markSeenBatch(chatId, [...rest, ...irrelevant].map(jobKey));
    log(`[${chatId}] First run: sent 1 newest, marked ${rest.length + irrelevant.length} as seen.`);
  } else if (relevantJobs.length > 0) {
    const sent = await sendJobs(chatId, relevantJobs, parsedMap);
    markSeenBatch(chatId, sent.map(jobKey));
    if (irrelevant.length > 0) markSeenBatch(chatId, irrelevant.map(jobKey));
    log(`[${chatId}] Sent ${sent.length} notifications.`);
  } else if (allJobs.length > 0) {
    markSeenBatch(chatId, allJobs.map(jobKey));
    log(`[${chatId}] No relevant jobs (${allJobs.length} filtered out by AI).`);
  } else {
    log(`[${chatId}] No new jobs.`);
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
