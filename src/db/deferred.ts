import { db } from "./connection";

interface DeferredRow {
  chat_id: string;
  job_key: string;
  cycles: number;
  updated_at: number;
}

const sql = {
  load: db.prepare(`SELECT chat_id, job_key, cycles, updated_at FROM deferred_jobs WHERE updated_at > ?`),
  upsert: db.prepare(`INSERT OR REPLACE INTO deferred_jobs (chat_id, job_key, cycles, updated_at) VALUES (?, ?, ?, ?)`),
  delete: db.prepare(`DELETE FROM deferred_jobs WHERE chat_id = ? AND job_key = ?`),
  prune: db.prepare(`DELETE FROM deferred_jobs WHERE updated_at < ?`),
  deleteByChat: db.prepare(`DELETE FROM deferred_jobs WHERE chat_id = ?`),
};

export function loadDeferredJobs(cutoffMs: number): Map<string, { cycles: number; updatedAt: number }> {
  const rows = sql.load.all(cutoffMs) as DeferredRow[];
  const map = new Map<string, { cycles: number; updatedAt: number }>();
  for (const row of rows) {
    map.set(`${row.chat_id}::${row.job_key}`, { cycles: row.cycles, updatedAt: row.updated_at });
  }
  return map;
}

export function upsertDeferred(chatId: string, jobKey: string, cycles: number, updatedAt: number): void {
  sql.upsert.run(chatId, jobKey, cycles, updatedAt);
}

export function deleteDeferred(chatId: string, jobKey: string): void {
  sql.delete.run(chatId, jobKey);
}

export function pruneDeferredDb(cutoffMs: number): void {
  sql.prune.run(cutoffMs);
}

export function deleteDeferredByChat(chatId: string): void {
  sql.deleteByChat.run(chatId);
}
