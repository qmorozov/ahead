import crypto from "crypto";
import type { Api } from "grammy";
import { Job, ParsedJob, jobKey } from "../types";
import { formatMessage, formatDigestItem, formatDigest } from "./format";
import {
  PendingJobEntry,
  savePendingJobBatch,
  deletePendingJobBatch,
  loadAllPendingJobs,
  pruneExpiredPendingJobs,
} from "../db";
import { log, logError } from "../lib/logger";
import { sleep } from "../lib/utils";
import { DELIVERY } from "../constants";
import { toRows } from "./keyboards";

let api: Api | undefined;

function getApi(): Api {
  if (!api) throw new Error("delivery: initPendingJobs() must be called before sending messages");
  return api;
}

const pendingJobs = new Map<string, PendingJobEntry>();
const STORE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 500;

export function initPendingJobs(botApi: Api): void {
  api = botApi;
  for (const entry of loadAllPendingJobs()) {
    pendingJobs.set(entry.id, entry);
  }
  if (pendingJobs.size > 0) log(`Restored ${pendingJobs.size} pending jobs`);
}

function cleanupPendingJobs(): void {
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [id, entry] of pendingJobs) {
    if (entry.storedAt < cutoff) pendingJobs.delete(id);
  }
  if (pendingJobs.size > MAX_PENDING) {
    const excess = pendingJobs.size - MAX_PENDING;
    const keys = [...pendingJobs.keys()].slice(0, excess);
    for (const key of keys) pendingJobs.delete(key);
    deletePendingJobBatch(keys);
  }
  pruneExpiredPendingJobs(cutoff);
}

export function getStoredJob(id: string): PendingJobEntry | undefined {
  return pendingJobs.get(id);
}

const MAX_SEND_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function sendWithRetry(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      await fn();
      return true;
    } catch (error) {
      if (attempt < MAX_SEND_RETRIES) {
        logError(`${label} (attempt ${attempt}/${MAX_SEND_RETRIES})`, error);
        await sleep(RETRY_DELAY_MS);
      } else {
        logError(label, error);
      }
    }
  }
  return false;
}

export async function sendJob(
  chatId: string,
  job: Job,
  parsed: ParsedJob | null = null,
): Promise<boolean> {
  return sendWithRetry("Telegram", () =>
    getApi().sendMessage(chatId, formatMessage(job, parsed), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: "View job posting", url: job.url }]],
      },
    }),
  );
}

interface DigestPage {
  text: string;
  buttons: Array<Array<{ text: string; callback_data: string }>>;
  jobs: Job[];
  entries: PendingJobEntry[];
}

function buildDigestPage(
  chatId: string,
  pageJobs: Job[],
  parsedMap: Map<string, ParsedJob | null>,
  pageOffset: number,
  totalJobs: number,
  signalsMap: Map<string, string[]> = new Map(),
): DigestPage {
  const items: string[] = [];
  const flatButtons: Array<{ text: string; callback_data: string }> = [];
  const entries: PendingJobEntry[] = [];

  for (let i = 0; i < pageJobs.length; i++) {
    const job = pageJobs[i]!;
    const globalIndex = pageOffset + i + 1;
    const key = jobKey(job);
    const parsed = parsedMap.get(key) ?? null;
    const signals = signalsMap.get(key);
    items.push(formatDigestItem(globalIndex, job, parsed, signals));

    const id = crypto.randomBytes(6).toString("base64url");
    const entry: PendingJobEntry = { id, chatId, job, parsed, storedAt: Date.now() };
    pendingJobs.set(id, entry);
    entries.push(entry);
    flatButtons.push({ text: String(globalIndex), callback_data: `job:${id}` });
  }

  const renderText = () => (pageOffset === 0 ? formatDigest(items, totalJobs) : items.join("\n\n"));
  let text = renderText();
  while (items.length > 1 && text.length > DELIVERY.MAX_LENGTH) {
    items.pop();
    entries.pop();
    flatButtons.pop();
    text = renderText();
  }

  return {
    text,
    buttons: toRows(flatButtons, 5),
    jobs: pageJobs.slice(0, items.length),
    entries,
  };
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

  for (let offset = 0; offset < jobs.length; offset += DELIVERY.PAGE_SIZE) {
    const pageJobs = jobs.slice(offset, offset + DELIVERY.PAGE_SIZE);
    const page = buildDigestPage(chatId, pageJobs, parsedMap, offset, jobs.length, signalsMap);
    allEntries.push(...page.entries);

    const pageSent = await sendWithRetry("Telegram digest", () =>
      getApi().sendMessage(chatId, page.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: page.buttons },
      }),
    );
    if (pageSent) sent.push(...page.jobs);

    if (offset + DELIVERY.PAGE_SIZE < jobs.length) await sleep(1000);
  }

  savePendingJobBatch(allEntries);
  log(
    `Sent digest: ${sent.length} jobs in ${Math.ceil(jobs.length / DELIVERY.PAGE_SIZE)} message(s)`,
  );
  return sent;
}
