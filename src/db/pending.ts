import { db } from "./connection";
import { Job, ParsedJob, ParsedJobSchema } from "../types";
import { log } from "../logger";

export interface PendingJobEntry {
  id: string;
  job: Job;
  parsed: ParsedJob | null;
  storedAt: number;
}

const stmtSavePendingJob = db.prepare(
  `INSERT OR REPLACE INTO pending_jobs (id, job_json, parsed_json, stored_at) VALUES (?, ?, ?, ?)`,
);
const stmtDeletePendingJob = db.prepare(`DELETE FROM pending_jobs WHERE id = ?`);
const stmtLoadPendingJobs = db.prepare(`SELECT * FROM pending_jobs`);
const stmtPrunePendingJobs = db.prepare(`DELETE FROM pending_jobs WHERE stored_at < ?`);

const savePendingJobBatchTx = db.transaction((entries: PendingJobEntry[]) => {
  for (const e of entries) {
    stmtSavePendingJob.run(
      e.id,
      JSON.stringify(e.job),
      e.parsed ? JSON.stringify(e.parsed) : null,
      e.storedAt,
    );
  }
});

export function savePendingJobBatch(entries: PendingJobEntry[]): void {
  if (entries.length > 0) savePendingJobBatchTx(entries);
}

export function deletePendingJob(id: string): void {
  stmtDeletePendingJob.run(id);
}

export function loadAllPendingJobs(): PendingJobEntry[] {
  const rows = stmtLoadPendingJobs.all() as Array<{
    id: string;
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
      result.push({ id: row.id, job, parsed, storedAt: row.stored_at });
    } catch (err) {
      log(`Skipping corrupted pending_jobs row id=${row.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}

export function pruneExpiredPendingJobs(cutoff: number): void {
  stmtPrunePendingJobs.run(cutoff);
}
