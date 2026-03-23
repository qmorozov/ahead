import { z } from "zod";
import { db } from "./connection";
import { THIRTY_DAYS_S } from "../constants";

const CountRowSchema = z.object({ n: z.number() });
const TagStatRowSchema = z.object({
  tag: z.string(),
  rejects: z.number(),
  views: z.number(),
});

const sql = {
  upsert: db.prepare(
    `INSERT OR REPLACE INTO feedback (chat_id, job_key, signal, tags, company, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  countByChat: db.prepare(
    `SELECT COUNT(*) as n FROM feedback WHERE chat_id = ? AND created_at > unixepoch() - ${THIRTY_DAYS_S}`,
  ),
  tagStats: db.prepare(`
    SELECT j.value AS tag,
      SUM(CASE WHEN f.signal = 'reject' THEN 1 ELSE 0 END) AS rejects,
      SUM(CASE WHEN f.signal = 'view' THEN 1 ELSE 0 END) AS views
    FROM feedback f, json_each(f.tags) j
    WHERE f.chat_id = ? AND f.created_at > unixepoch() - ${THIRTY_DAYS_S}
    GROUP BY j.value
  `),
  prune: db.prepare(`DELETE FROM feedback WHERE created_at < unixepoch() - ${THIRTY_DAYS_S}`),
  deleteByChat: db.prepare(`DELETE FROM feedback WHERE chat_id = ?`),
};

export function recordFeedback(
  chatId: string,
  jobKey: string,
  signal: "view" | "reject",
  tags: string[],
  company: string,
): void {
  sql.upsert.run(chatId, jobKey, signal, JSON.stringify(tags), company, Math.floor(Date.now() / 1000));
}

export interface TagPreference {
  tag: string;
  rejects: number;
  views: number;
  ratio: number;
}

const MIN_FEEDBACKS = 5;
const MIN_TAG_OCCURRENCES_AVOID = 3;
const MIN_TAG_OCCURRENCES_PREFER = 2;
const AVOID_THRESHOLD = 0.3;
const PREFER_THRESHOLD = 0.7;

export function getTagPreferences(chatId: string): {
  avoided: TagPreference[];
  preferred: TagPreference[];
} | null {
  const rawCount = CountRowSchema.safeParse(sql.countByChat.get(chatId));
  const count = rawCount.success ? rawCount.data.n : 0;
  if (count < MIN_FEEDBACKS) return null;

  const avoided: TagPreference[] = [];
  const preferred: TagPreference[] = [];

  for (const raw of sql.tagStats.all(chatId)) {
    const parsed = TagStatRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const total = row.rejects + row.views;
    if (total === 0) continue;
    const ratio = row.views / total;
    const pref = { tag: row.tag, rejects: row.rejects, views: row.views, ratio };

    if (ratio <= AVOID_THRESHOLD && total >= MIN_TAG_OCCURRENCES_AVOID) {
      avoided.push(pref);
    } else if (ratio >= PREFER_THRESHOLD && total >= MIN_TAG_OCCURRENCES_PREFER) {
      preferred.push(pref);
    }
  }

  if (avoided.length === 0 && preferred.length === 0) return null;
  return { avoided, preferred };
}

export function buildPreferenceSummary(
  chatId: string,
  prefetched?: { avoided: TagPreference[]; preferred: TagPreference[] } | null,
): string {
  const prefs = prefetched !== undefined ? prefetched : getTagPreferences(chatId);
  if (!prefs) return "";
  const parts: string[] = [];
  if (prefs.avoided.length > 0) parts.push(`avoids: ${prefs.avoided.map((p) => p.tag).join(", ")}`);
  if (prefs.preferred.length > 0)
    parts.push(`prefers: ${prefs.preferred.map((p) => p.tag).join(", ")}`);
  return parts.join(". ");
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let lastPrunedAt = 0;

export function pruneFeedback(): void {
  const now = Date.now();
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  sql.prune.run();
}

export function deleteFeedbackByChat(chatId: string): void {
  sql.deleteByChat.run(chatId);
}
