import { z } from "zod";
import { db } from "./connection";
import { Job, ParsedJob, JobSchema, ParsedJobSchema } from "../types";
import { warn } from "../lib/logger";

const PendingRowSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  job_json: z.string(),
  parsed_json: z.string().nullable(),
  stored_at: z.number(),
});

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

export const deletePendingJobBatch = db.transaction((ids: string[]) => {
  for (const id of ids) sql.delete.run(id);
});

export function deletePendingByChatId(chatId: string): void {
  sql.deleteByChatId.run(chatId);
}

/**
 * Load all pending jobs from the database.
 * Validates job JSON through Zod - corrupted rows are skipped with a warning.
 */
export function loadAllPendingJobs(): PendingJobEntry[] {
  const result: PendingJobEntry[] = [];
  for (const raw of sql.loadAll.all()) {
    const rowResult = PendingRowSchema.safeParse(raw);
    if (!rowResult.success) continue;
    const row = rowResult.data;
    try {
      const jobResult = JobSchema.safeParse(JSON.parse(row.job_json));
      if (!jobResult.success) {
        warn(`Skipping pending_jobs row id=${row.id}: invalid job JSON`);
        continue;
      }
      let parsed: ParsedJob | null = null;
      if (row.parsed_json) {
        const r = ParsedJobSchema.safeParse(JSON.parse(row.parsed_json));
        parsed = r.success ? r.data : null;
      }
      result.push({
        id: row.id,
        chatId: row.chat_id,
        job: jobResult.data,
        parsed,
        storedAt: row.stored_at,
      });
    } catch (err) {
      warn(
        `Skipping corrupted pending_jobs row id=${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return result;
}

export function pruneExpiredPendingJobs(cutoff: number): void {
  sql.prune.run(cutoff);
}
