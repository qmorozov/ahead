import { db } from "./connection";

const THIRTY_DAYS_S = 2_592_000;

// seen_jobs: tracks delivered jobs per user (dedup by source + id)

const jobsSql = {
  isSeen: db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? AND job_key = ?`),
  mark: db.prepare(`INSERT OR IGNORE INTO seen_jobs (chat_id, job_key) VALUES (?, ?)`),
  hasAny: db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? LIMIT 1`),
  loadKeys: db.prepare(`SELECT job_key FROM seen_jobs WHERE chat_id = ?`),
  prune: db.prepare(`
    DELETE FROM seen_jobs WHERE chat_id = ? AND rowid NOT IN (
      SELECT rowid FROM seen_jobs WHERE chat_id = ? ORDER BY seen_at DESC LIMIT 10000
    )
  `),
};

export function isSeen(chatId: string, jobKey: string): boolean {
  return jobsSql.isSeen.get(chatId, jobKey) !== undefined;
}

export function loadSeenKeys(chatId: string): Set<string> {
  return new Set(
    (jobsSql.loadKeys.all(chatId) as Array<{ job_key: string }>).map((r) => r.job_key),
  );
}

export const markSeenBatch = db.transaction((chatId: string, keys: string[]) => {
  for (const key of keys) jobsSql.mark.run(chatId, key);
});

export function isFirstRun(chatId: string): boolean {
  return jobsSql.hasAny.get(chatId) === undefined;
}

export function pruneSeen(chatId: string): void {
  jobsSql.prune.run(chatId, chatId);
}

// seen_titles: cross source dedup by normalized title + company (30day window)

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
  return new Set(
    (titlesSql.loadKeys.all(chatId) as Array<{ norm_key: string }>).map((r) => r.norm_key),
  );
}

export function markTitleSeen(chatId: string, normKey: string): void {
  titlesSql.mark.run(chatId, normKey);
}

export function pruneSeenTitles(): void {
  titlesSql.prune.run();
}
