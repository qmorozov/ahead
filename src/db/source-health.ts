import { db } from "./connection";

export interface SourceHealthRow {
  source: string;
  last_success_at: number | null;
  last_job_count: number | null;
  fail_streak: number;
}

const sql = {
  get: db.prepare(`SELECT * FROM source_health WHERE source = ?`),
  getAll: db.prepare(`SELECT * FROM source_health ORDER BY source`),
  upsertSuccess: db.prepare(`
    INSERT INTO source_health (source, last_success_at, last_job_count, fail_streak)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(source) DO UPDATE SET
      last_success_at = excluded.last_success_at,
      last_job_count = excluded.last_job_count,
      fail_streak = 0
  `),
  incrementFail: db.prepare(`
    INSERT INTO source_health (source, fail_streak)
    VALUES (?, 1)
    ON CONFLICT(source) DO UPDATE SET
      fail_streak = source_health.fail_streak + 1
  `),
};

export function recordSourceSuccess(source: string, jobCount: number): void {
  sql.upsertSuccess.run(source, Date.now(), jobCount);
}

export function recordSourceFailure(source: string): void {
  sql.incrementFail.run(source);
}

export function getSourceHealth(source: string): SourceHealthRow | null {
  return (sql.get.get(source) as SourceHealthRow) ?? null;
}

export function getAllSourceHealth(): SourceHealthRow[] {
  return sql.getAll.all() as SourceHealthRow[];
}
