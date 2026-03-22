import { z } from "zod";
import { db } from "./connection";

const SlugRowSchema = z.object({ slug: z.string() });
const CountRowSchema = z.object({ cnt: z.number() });
const EtagRowSchema = z.object({ etag: z.string().nullable() });

function slugs(rows: unknown[]): string[] {
  const result: string[] = [];
  for (const row of rows) {
    const parsed = SlugRowSchema.safeParse(row);
    if (parsed.success) result.push(parsed.data.slug);
  }
  return result;
}

const sql = {
  upsert: db.prepare(`
    INSERT INTO boards (slug, platform, active, job_count, last_checked)
    VALUES (@slug, @platform, @active, @job_count, unixepoch())
    ON CONFLICT(slug, platform) DO UPDATE SET
      active = @active, job_count = @job_count, last_checked = unixepoch()
  `),
  count: db.prepare(`SELECT COUNT(*) as cnt FROM boards WHERE platform = ?`),
  active: db.prepare(`SELECT slug FROM boards WHERE platform = ? AND active = 1`),
  // Adaptive staleness: boards with consecutive 304s are checked less often.
  // Base interval * 2^min(n, 4) gives: 1h, 2h, 4h, 8h, 16h
  stale: db.prepare(`
    SELECT slug FROM boards WHERE platform = ? AND active = 1
      AND (last_checked IS NULL
           OR last_checked < unixepoch() - ? * (1 << MIN(consecutive_304s, 4)))
    ORDER BY job_count DESC
  `),
  getEtag: db.prepare(`SELECT etag FROM boards WHERE slug = ? AND platform = ?`),
  setEtag: db.prepare(`UPDATE boards SET etag = ? WHERE slug = ? AND platform = ?`),
  increment304: db.prepare(
    `UPDATE boards SET consecutive_304s = consecutive_304s + 1 WHERE slug = ? AND platform = ?`,
  ),
  reset304: db.prepare(`UPDATE boards SET consecutive_304s = 0 WHERE slug = ? AND platform = ?`),
  reactivateAll: db.prepare(`UPDATE boards SET active = 1 WHERE platform = ? AND active = 0`),
};

const upsertBatch = db.transaction(
  (boards: Array<{ slug: string; platform: string; active: number; job_count: number }>) => {
    for (const b of boards) sql.upsert.run(b);
  },
);

/**
 * Seed board slugs for a platform. If already seeded, reactivates any disabled boards.
 * Idempotent: safe to call on every startup.
 */
export function seedBoards(boardSlugs: string[], platform: string): void {
  const existing = CountRowSchema.parse(sql.count.get(platform)).cnt;
  if (existing >= boardSlugs.length) {
    sql.reactivateAll.run(platform);
    return;
  }
  upsertBatch(boardSlugs.map((slug) => ({ slug, platform, active: 1, job_count: 0 })));
}

export function getActiveSlugs(platform: string): string[] {
  return slugs(sql.active.all(platform));
}

/** Return active slugs that haven't been checked recently (adaptive back-off for 304s). */
export function getStaleSlugs(platform: string, maxAgeSeconds: number): string[] {
  return slugs(sql.stale.all(platform, maxAgeSeconds));
}

export function updateBoard(
  slug: string,
  platform: string,
  active: boolean,
  jobCount: number,
): void {
  sql.upsert.run({ slug, platform, active: active ? 1 : 0, job_count: jobCount });
}

export function getEtag(slug: string, platform: string): string | null {
  const row = sql.getEtag.get(slug, platform);
  if (!row) return null;
  return EtagRowSchema.parse(row).etag;
}

export function setEtag(slug: string, platform: string, etag: string | null): void {
  sql.setEtag.run(etag, slug, platform);
}

/** Bump the consecutive-304 counter (used to back off stale board polling). */
export function increment304(slug: string, platform: string): void {
  sql.increment304.run(slug, platform);
}

export function reset304(slug: string, platform: string): void {
  sql.reset304.run(slug, platform);
}
