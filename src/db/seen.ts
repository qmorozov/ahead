import { z } from "zod";
import { db } from "./connection";

const THIRTY_DAYS_S = 2_592_000;

const JobKeyRowSchema = z.object({ job_key: z.string() });
const NormKeyRowSchema = z.object({ norm_key: z.string() });

// seen_jobs - per-user dedup by job key

const jobsSql = {
  isSeen: db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? AND job_key = ?`),
  mark: db.prepare(`INSERT OR IGNORE INTO seen_jobs (chat_id, job_key) VALUES (?, ?)`),
  hasAny: db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? LIMIT 1`),
  loadKeys: db.prepare(`SELECT job_key FROM seen_jobs WHERE chat_id = ?`),
  prune: db.prepare(
    `DELETE FROM seen_jobs WHERE chat_id = ? AND seen_at < unixepoch() - ${THIRTY_DAYS_S}`,
  ),
};

export function isSeen(chatId: string, jobKey: string): boolean {
  return jobsSql.isSeen.get(chatId, jobKey) !== undefined;
}

export function loadSeenKeys(chatId: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of jobsSql.loadKeys.all(chatId)) {
    const parsed = JobKeyRowSchema.safeParse(raw);
    if (parsed.success) keys.add(parsed.data.job_key);
  }
  return keys;
}

export const markSeenBatch = db.transaction((chatId: string, keys: string[]) => {
  for (const key of keys) jobsSql.mark.run(chatId, key);
});

export function isFirstRun(chatId: string): boolean {
  return jobsSql.hasAny.get(chatId) === undefined;
}

export function pruneSeen(chatId: string): void {
  jobsSql.prune.run(chatId);
}

// seen_titles: cross-source dedup by normalized title + company (30-day window)

const titlesSql = {
  isSeen: db.prepare(
    `SELECT 1 FROM seen_titles WHERE chat_id = ? AND norm_key = ? AND seen_at > unixepoch() - ${THIRTY_DAYS_S}`,
  ),
  mark: db.prepare(`INSERT OR IGNORE INTO seen_titles (chat_id, norm_key) VALUES (?, ?)`),
  loadKeys: db.prepare(
    `SELECT norm_key FROM seen_titles WHERE chat_id = ? AND seen_at > unixepoch() - ${THIRTY_DAYS_S}`,
  ),
  prune: db.prepare(`DELETE FROM seen_titles WHERE seen_at < unixepoch() - ${THIRTY_DAYS_S}`),
};

export function isTitleSeen(chatId: string, normKey: string): boolean {
  return titlesSql.isSeen.get(chatId, normKey) !== undefined;
}

export function loadSeenTitles(chatId: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of titlesSql.loadKeys.all(chatId)) {
    const parsed = NormKeyRowSchema.safeParse(raw);
    if (parsed.success) keys.add(parsed.data.norm_key);
  }
  return keys;
}

export function markTitleSeen(chatId: string, normKey: string): void {
  titlesSql.mark.run(chatId, normKey);
}

export const markTitleSeenBatch = db.transaction((chatId: string, normKeys: string[]) => {
  for (const nk of normKeys) titlesSql.mark.run(chatId, nk);
});

export function pruneSeenTitles(): void {
  titlesSql.prune.run();
}
