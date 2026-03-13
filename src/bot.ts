import TelegramBot from "node-telegram-bot-api";
import { config } from "./config";
import { Job, ParsedJob } from "./types";
import { formatMessage, formatDigestItem, formatDigest } from "./format";
import { jobKey } from "./db";
import { log, logError } from "./logger";
import { sleep } from "./utils";

export const bot = new TelegramBot(config.telegramBotToken, { polling: true });

interface StoredJob {
  job: Job;
  parsed: ParsedJob | null;
  storedAt: number;
}

const pendingJobs = new Map<string, StoredJob>();
const STORE_TTL_MS = 24 * 60 * 60 * 1000;

function generateId(): string {
  return Math.random().toString(36).substring(2, 8);
}

const MAX_PENDING = 500;

function cleanupPendingJobs(): void {
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [id, entry] of pendingJobs) {
    if (entry.storedAt < cutoff) pendingJobs.delete(id);
  }
  if (pendingJobs.size > MAX_PENDING) {
    const excess = pendingJobs.size - MAX_PENDING;
    const keys = [...pendingJobs.keys()].slice(0, excess);
    for (const key of keys) pendingJobs.delete(key);
  }
}

export function getStoredJob(id: string): { job: Job; parsed: ParsedJob | null } | undefined {
  return pendingJobs.get(id);
}

export async function sendJob(
  chatId: string,
  job: Job,
  parsed: ParsedJob | null = null,
): Promise<boolean> {
  try {
    const message = formatMessage(job, parsed);
    await bot.sendMessage(chatId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
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

export async function sendJobs(
  chatId: string,
  jobs: Job[],
  parsedMap: Map<string, ParsedJob | null> = new Map(),
): Promise<Job[]> {
  cleanupPendingJobs();

  const sent: Job[] = [];

  for (let page = 0; page < jobs.length; page += DIGEST_PAGE_SIZE) {
    const pageJobs = jobs.slice(page, page + DIGEST_PAGE_SIZE);
    const items: string[] = [];
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    let buttonRow: Array<{ text: string; callback_data: string }> = [];

    for (let i = 0; i < pageJobs.length; i++) {
      const job = pageJobs[i]!;
      const parsed = parsedMap.get(jobKey(job)) ?? null;
      const globalIndex = page + i + 1;

      items.push(formatDigestItem(globalIndex, job, parsed));

      const id = generateId();
      pendingJobs.set(id, { job, parsed, storedAt: Date.now() });

      buttonRow.push({ text: String(globalIndex), callback_data: `job:${id}` });

      if (buttonRow.length === BUTTONS_PER_ROW || i === pageJobs.length - 1) {
        buttons.push(buttonRow);
        buttonRow = [];
      }
    }

    const text =
      page === 0 ? formatDigest(items, jobs.length) : items.join("\n\n");

    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons },
      });
      sent.push(...pageJobs);
    } catch (error) {
      logError("Telegram digest", error);
    }

    if (page + DIGEST_PAGE_SIZE < jobs.length) {
      await sleep(1000);
    }
  }

  log(`Sent digest: ${sent.length} jobs in ${Math.ceil(jobs.length / DIGEST_PAGE_SIZE)} message(s)`);
  return sent;
}
