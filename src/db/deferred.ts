import { z } from "zod";
import { db } from "./connection";

const DeferredRowSchema = z.object({
  chat_id: z.string(),
  job_key: z.string(),
  cycles: z.number(),
  updated_at: z.number(),
});

const CyclesRowSchema = z.object({ cycles: z.number() });
const CyclesRowWithKeySchema = z.object({ job_key: z.string(), cycles: z.number() });

const sql = {
  load: db.prepare(
    `SELECT chat_id, job_key, cycles, updated_at FROM deferred_jobs WHERE updated_at > ?`,
  ),
  loadByChat: db.prepare(`SELECT job_key, cycles FROM deferred_jobs WHERE chat_id = ?`),
  getCycles: db.prepare(`SELECT cycles FROM deferred_jobs WHERE chat_id = ? AND job_key = ?`),
  upsert: db.prepare(
    `INSERT OR REPLACE INTO deferred_jobs (chat_id, job_key, cycles, updated_at) VALUES (?, ?, ?, ?)`,
  ),
  delete: db.prepare(`DELETE FROM deferred_jobs WHERE chat_id = ? AND job_key = ?`),
  prune: db.prepare(`DELETE FROM deferred_jobs WHERE updated_at < ?`),
  deleteByChat: db.prepare(`DELETE FROM deferred_jobs WHERE chat_id = ?`),
};

export function loadDeferredJobs(
  cutoffMs: number,
): Map<string, { cycles: number; updatedAt: number }> {
  const rows = sql.load.all(cutoffMs);
  const map = new Map<string, { cycles: number; updatedAt: number }>();
  for (const raw of rows) {
    const parsed = DeferredRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    map.set(`${row.chat_id}::${row.job_key}`, { cycles: row.cycles, updatedAt: row.updated_at });
  }
  return map;
}

export function loadDeferredForChat(chatId: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of sql.loadByChat.all(chatId)) {
    const parsed = CyclesRowWithKeySchema.safeParse(raw);
    if (parsed.success) map.set(parsed.data.job_key, parsed.data.cycles);
  }
  return map;
}

export interface DeferredWrite {
  type: "upsert" | "delete";
  jobKey: string;
  cycles?: number;
  updatedAt?: number;
}

export const flushDeferredBatch = db.transaction((chatId: string, writes: DeferredWrite[]) => {
  for (const w of writes) {
    if (w.type === "delete") sql.delete.run(chatId, w.jobKey);
    else sql.upsert.run(chatId, w.jobKey, w.cycles!, w.updatedAt!);
  }
});

export function getDeferredCycles(chatId: string, jobKey: string): number | undefined {
  const row = sql.getCycles.get(chatId, jobKey);
  if (!row) return undefined;
  return CyclesRowSchema.parse(row).cycles;
}

export function upsertDeferred(
  chatId: string,
  jobKey: string,
  cycles: number,
  updatedAt: number,
): void {
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
