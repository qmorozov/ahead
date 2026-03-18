import { db } from "./connection";
import { Job, ParsedJob, ParsedJobSchema } from "../types";
import { log } from "../lib/logger";

export interface PendingJobEntry {
  id: string;
  chatId: string;
  job: Job;
  parsed: ParsedJob | null;
  storedAt: number;
}

const sql = {
  save: db.prepare(
    `INSERT OR REPLACE INTO pending_jobs (id, chat_id, job_json, parsed_json, stored_at) VALUES (?, ?, ?, ?, ?)`,
  ),
  delete: db.prepare(`DELETE FROM pending_jobs WHERE id = ?`),
  deleteByChatId: db.prepare(`DELETE FROM pending_jobs WHERE chat_id = ?`),
  loadAll: db.prepare(`SELECT * FROM pending_jobs`),
  prune: db.prepare(`DELETE FROM pending_jobs WHERE stored_at < ?`),
};

const saveBatchTx = db.transaction((entries: PendingJobEntry[]) => {
  for (const e of entries) {
    sql.save.run(
      e.id,
      e.chatId,
      JSON.stringify(e.job),
      e.parsed ? JSON.stringify(e.parsed) : null,
      e.storedAt,
    );
  }
});

export function savePendingJobBatch(entries: PendingJobEntry[]): void {
  if (entries.length > 0) saveBatchTx(entries);
}

export function deletePendingJob(id: string): void {
  sql.delete.run(id);
}

export function deletePendingByChatId(chatId: string): void {
  sql.deleteByChatId.run(chatId);
}

export function loadAllPendingJobs(): PendingJobEntry[] {
  const rows = sql.loadAll.all() as Array<{
    id: string;
    chat_id: string;
    job_json: string;
    parsed_json: string | null;
    stored_at: number;
  }>;
  const result: PendingJobEntry[] = [];
  for (const row of rows) {
    try {
      const job = JSON.parse(row.job_json) as Job;
      let parsed: ParsedJob | null = null;
      if (row.parsed_json) {
        const r = ParsedJobSchema.safeParse(JSON.parse(row.parsed_json));
        parsed = r.success ? r.data : null;
      }
      result.push({ id: row.id, chatId: row.chat_id, job, parsed, storedAt: row.stored_at });
    } catch (err) {
      log(
        `Skipping corrupted pending_jobs row id=${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return result;
}

export function pruneExpiredPendingJobs(cutoff: number): void {
  sql.prune.run(cutoff);
}
