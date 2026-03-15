import crypto from "crypto";
import { bot } from "./bot";
import { Job, ParsedJob, jobKey } from "./types";
import { formatMessage, formatDigestItem, formatDigest } from "./format";
import {
  PendingJobEntry,
  savePendingJobBatch,
  deletePendingJob,
  loadAllPendingJobs,
  pruneExpiredPendingJobs,
} from "./db";
import { log, logError } from "./logger";
import { sleep } from "./utils";

const pendingJobs = new Map<string, PendingJobEntry>();
const STORE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 500;

for (const entry of loadAllPendingJobs()) {
  pendingJobs.set(entry.id, entry);
}
if (pendingJobs.size > 0) log(`Restored ${pendingJobs.size} pending jobs`);

function generateId(): string {
  return crypto.randomBytes(6).toString("base64url");
}

function cleanupPendingJobs(): void {
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [id, entry] of pendingJobs) {
    if (entry.storedAt < cutoff) pendingJobs.delete(id);
  }
  if (pendingJobs.size > MAX_PENDING) {
    const excess = pendingJobs.size - MAX_PENDING;
    const keys = [...pendingJobs.keys()].slice(0, excess);
    for (const key of keys) {
      pendingJobs.delete(key);
      deletePendingJob(key);
    }
  }
  pruneExpiredPendingJobs(cutoff);
}

export function getStoredJob(id: string): PendingJobEntry | undefined {
  return pendingJobs.get(id);
}

export async function sendJob(
  chatId: string,
  job: Job,
  parsed: ParsedJob | null = null,
): Promise<boolean> {
  try {
    await bot.api.sendMessage(chatId, formatMessage(job, parsed), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: "View job posting", url: job.url }]],
      },
    });
    return true;
  } catch (error) {
    logError("Telegram", error);
    return false;
  }
}

const DIGEST_PAGE_SIZE = 10;
const BUTTONS_PER_ROW = 5;

interface DigestPage {
  text: string;
  buttons: Array<Array<{ text: string; callback_data: string }>>;
  jobs: Job[];
  entries: PendingJobEntry[];
}

function buildDigestPage(
  pageJobs: Job[],
  parsedMap: Map<string, ParsedJob | null>,
  pageOffset: number,
  totalJobs: number,
  signalsMap: Map<string, string[]> = new Map(),
): DigestPage {
  const items: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  const entries: PendingJobEntry[] = [];
  let buttonRow: Array<{ text: string; callback_data: string }> = [];

  for (let i = 0; i < pageJobs.length; i++) {
    const job = pageJobs[i];
    if (!job) continue;
    const globalIndex = pageOffset + i + 1;
    const parsed = parsedMap.get(jobKey(job)) ?? null;
    const signals = signalsMap.get(jobKey(job));
    items.push(formatDigestItem(globalIndex, job, parsed, signals));

    const id = generateId();
    const entry: PendingJobEntry = { id, job, parsed, storedAt: Date.now() };
    pendingJobs.set(id, entry);
    entries.push(entry);

    buttonRow.push({ text: String(globalIndex), callback_data: `job:${id}` });
    if (buttonRow.length === BUTTONS_PER_ROW || i === pageJobs.length - 1) {
      buttons.push(buttonRow);
      buttonRow = [];
    }
  }

  const text = pageOffset === 0 ? formatDigest(items, totalJobs) : items.join("\n\n");

  return { text, buttons, jobs: pageJobs, entries };
}

export async function sendJobs(
  chatId: string,
  jobs: Job[],
  parsedMap: Map<string, ParsedJob | null> = new Map(),
  signalsMap: Map<string, string[]> = new Map(),
): Promise<Job[]> {
  cleanupPendingJobs();

  const sent: Job[] = [];
  const allEntries: PendingJobEntry[] = [];

  for (let offset = 0; offset < jobs.length; offset += DIGEST_PAGE_SIZE) {
    const pageJobs = jobs.slice(offset, offset + DIGEST_PAGE_SIZE);
    const page = buildDigestPage(pageJobs, parsedMap, offset, jobs.length, signalsMap);
    allEntries.push(...page.entries);

    try {
      await bot.api.sendMessage(chatId, page.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: page.buttons },
      });
      sent.push(...page.jobs);
    } catch (error) {
      logError("Telegram digest", error);
    }

    if (offset + DIGEST_PAGE_SIZE < jobs.length) {
      await sleep(1000);
    }
  }

  savePendingJobBatch(allEntries);
  log(`Sent digest: ${sent.length} jobs in ${Math.ceil(jobs.length / DIGEST_PAGE_SIZE)} message(s)`);
  return sent;
}
