import { db } from "./connection";

const stmtIsSeen = db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? AND job_key = ?`);
const stmtMarkSeen = db.prepare(`INSERT OR IGNORE INTO seen_jobs (chat_id, job_key) VALUES (?, ?)`);
const stmtHasAnySeen = db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? LIMIT 1`);
const stmtPruneSeen = db.prepare(`
  DELETE FROM seen_jobs WHERE chat_id = ? AND rowid NOT IN (
    SELECT rowid FROM seen_jobs WHERE chat_id = ? ORDER BY seen_at DESC LIMIT 10000
  )
`);

export function isSeen(chatId: string, jobKey: string): boolean {
  return stmtIsSeen.get(chatId, jobKey) !== undefined;
}

const markSeenBatchTx = db.transaction((chatId: string, keys: string[]) => {
  for (const key of keys) {
    stmtMarkSeen.run(chatId, key);
  }
});

export function markSeenBatch(chatId: string, keys: string[]): void {
  markSeenBatchTx(chatId, keys);
}

export function isFirstRun(chatId: string): boolean {
  return stmtHasAnySeen.get(chatId) === undefined;
}

export function pruneSeen(chatId: string): void {
  stmtPruneSeen.run(chatId, chatId);
}

const stmtIsSeenTitle = db.prepare(`SELECT 1 FROM seen_titles WHERE chat_id = ? AND norm_key = ? AND seen_at > unixepoch() - 2592000`);
const stmtMarkSeenTitle = db.prepare(`INSERT OR IGNORE INTO seen_titles (chat_id, norm_key) VALUES (?, ?)`);
const stmtPruneSeenTitles = db.prepare(`DELETE FROM seen_titles WHERE seen_at < unixepoch() - 2592000`);

export function isTitleSeen(chatId: string, normKey: string): boolean {
  return stmtIsSeenTitle.get(chatId, normKey) !== undefined;
}

export function markTitleSeen(chatId: string, normKey: string): void {
  stmtMarkSeenTitle.run(chatId, normKey);
}

export function pruneSeenTitles(): void {
  stmtPruneSeenTitles.run();
}
