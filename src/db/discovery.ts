import { z } from "zod";
import { db } from "./connection";
import { DISCOVERY } from "../constants";

const DiscoveryRow = z.object({ discovered_at: z.number() });

interface DiscoveryEntry {
  jobKey: string;
  source: string;
  sourcePublishedAt: string | null;
  isBackfill: boolean;
}

const upsertStmt = db.prepare(`
  INSERT INTO job_discovery (job_key, source, source_published_at, discovered_at, last_seen_at, is_backfill)
  VALUES (?, ?, ?, unixepoch(), unixepoch(), ?)
  ON CONFLICT(job_key) DO UPDATE SET last_seen_at = unixepoch()
`);

const getStmt = db.prepare(`SELECT discovered_at FROM job_discovery WHERE job_key = ?`);

const touchStmt = db.prepare(
  `UPDATE job_discovery SET last_seen_at = unixepoch() WHERE job_key = ? AND last_seen_at < unixepoch() - 86400`,
);

const pruneStmt = db.prepare(`DELETE FROM job_discovery WHERE last_seen_at < ?`);

export function upsertDiscoveryBatch(entries: DiscoveryEntry[]): void {
  if (entries.length === 0) return;
  db.transaction(() => {
    for (const e of entries) {
      upsertStmt.run(e.jobKey, e.source, e.sourcePublishedAt, e.isBackfill ? 1 : 0);
    }
  })();
}

export function getDiscoveryDates(keys: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of keys) {
    const parsed = DiscoveryRow.safeParse(getStmt.get(key));
    if (parsed.success) result.set(key, parsed.data.discovered_at * 1000); // seconds → ms
  }
  return result;
}

export function touchDiscoveryBatch(keys: string[]): void {
  if (keys.length === 0) return;
  db.transaction(() => {
    for (const key of keys) touchStmt.run(key);
  })();
}

export function pruneDiscovery(): void {
  pruneStmt.run(Math.floor(Date.now() / 1000) - DISCOVERY.PRUNE_DAYS * 86_400);
}
