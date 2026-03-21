import { z } from "zod";
import { db } from "./connection";
import { ParsedJob, ParsedJobSchema } from "../types";
import { log } from "../lib/logger";

const SECONDS_PER_DAY = 86_400;

const ParsedRowSchema = z.object({ parsed_json: z.string(), parse_quality: z.string() });
const UrlRowSchema = z.object({ url: z.string().nullable() });
const ValueRowSchema = z.object({ value: z.string() });
const CountRowSchema = z.object({ n: z.number() });

export type ParseQuality = "full" | "quick";

export interface CachedParse {
  parsed: ParsedJob;
  quality: ParseQuality;
}

const sql = {
  getParsed: db.prepare(`SELECT parsed_json, parse_quality FROM parsed_jobs WHERE job_key = ?`),
  setParsed: db.prepare(
    `INSERT OR REPLACE INTO parsed_jobs (job_key, parsed_json, parse_quality) VALUES (?, ?, ?)`,
  ),
  pruneParsed: db.prepare(`DELETE FROM parsed_jobs WHERE parsed_at < unixepoch() - ?`),

  getCompanyUrl: db.prepare(`SELECT url FROM company_urls WHERE name = ?`),
  setCompanyUrl: db.prepare(`INSERT OR REPLACE INTO company_urls (name, url) VALUES (?, ?)`),
  pruneCompanyUrls: db.prepare(`DELETE FROM company_urls WHERE resolved_at < unixepoch() - ?`),

  getQuota: db.prepare(`SELECT value FROM llm_quota WHERE key = ?`),
  setQuota: db.prepare(`INSERT OR REPLACE INTO llm_quota (key, value) VALUES (?, ?)`),
};

// Parsed jobs cache (30-day TTL)

// Returns null both when not found and when stored JSON is corrupted
export function getCachedParse(jobKey: string): CachedParse | null {
  const raw = sql.getParsed.get(jobKey);
  if (!raw) return null;
  const row = ParsedRowSchema.safeParse(raw);
  if (!row.success) return null;
  try {
    const result = ParsedJobSchema.safeParse(JSON.parse(row.data.parsed_json));
    if (!result.success) return null;
    return { parsed: result.data, quality: row.data.parse_quality === "quick" ? "quick" : "full" };
  } catch {
    return null;
  }
}

export function setCachedParse(
  jobKey: string,
  parsed: ParsedJob,
  quality: ParseQuality = "full",
): void {
  sql.setParsed.run(jobKey, JSON.stringify(parsed), quality);
}

export function pruneParsedCache(maxAgeDays = 30): void {
  const { changes } = sql.pruneParsed.run(maxAgeDays * SECONDS_PER_DAY);
  if (changes > 0) log(`Pruned ${changes} old parsed_jobs entries`);
}

// Company URL cache (90-day TTL)

// undefined = never looked up, null = looked up but company not found
export function getCachedCompanyUrl(name: string): string | null | undefined {
  const raw = sql.getCompanyUrl.get(name);
  if (!raw) return undefined;
  const row = UrlRowSchema.safeParse(raw);
  return row.success ? row.data.url : undefined;
}

export function setCachedCompanyUrl(name: string, url: string | null): void {
  sql.setCompanyUrl.run(name, url);
}

export function pruneCompanyUrls(maxAgeDays = 90): void {
  const { changes } = sql.pruneCompanyUrls.run(maxAgeDays * SECONDS_PER_DAY);
  if (changes > 0) log(`Pruned ${changes} old company_urls entries`);
}

// LLM quota (key-value store for rate limit state)

export function getLlmQuotaValue(key: string): string | null {
  const raw = sql.getQuota.get(key);
  if (!raw) return null;
  const row = ValueRowSchema.safeParse(raw);
  return row.success ? row.data.value : null;
}

export function setLlmQuotaValue(key: string, value: string): void {
  sql.setQuota.run(key, value);
}

// LLM parse tracking (dedicated table for hourly budget enforcement)

const parseSql = {
  count: db.prepare(`SELECT COUNT(*) AS n FROM llm_parses WHERE parsed_at > ?`),
  insert: db.prepare(`INSERT INTO llm_parses (parsed_at) VALUES (?)`),
  prune: db.prepare(`DELETE FROM llm_parses WHERE parsed_at < ?`),
};

export function countRecentParses(cutoffMs: number): number {
  return CountRowSchema.parse(parseSql.count.get(cutoffMs)).n;
}

export function recordParseTimestamp(ts: number): void {
  parseSql.insert.run(ts);
}

export function pruneParseTimestamps(cutoffMs: number): void {
  parseSql.prune.run(cutoffMs);
}
