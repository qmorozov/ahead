import { z } from "zod";
import { db } from "./connection";

const SourceHealthRowSchema = z.object({
  source: z.string(),
  last_success_at: z.number().nullable(),
  last_job_count: z.number().nullable(),
  fail_streak: z.number(),
});

export type SourceHealthRow = z.infer<typeof SourceHealthRowSchema>;

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
  const row = sql.get.get(source);
  if (!row) return null;
  const parsed = SourceHealthRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function getAllSourceHealth(): SourceHealthRow[] {
  const rows = sql.getAll.all();
  const result: SourceHealthRow[] = [];
  for (const raw of rows) {
    const parsed = SourceHealthRowSchema.safeParse(raw);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
