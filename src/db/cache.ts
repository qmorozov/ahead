import { db } from "./connection";
import { ParsedJob, ParsedJobSchema } from "../types";
import { log } from "../lib/logger";

const SECONDS_PER_DAY = 86_400;

export type ParseQuality = "full" | "quick";

export interface CachedParse {
  parsed: ParsedJob;
  quality: ParseQuality;
}

const sql = {
  getParsed: db.prepare(`SELECT parsed_json, parse_quality FROM parsed_jobs WHERE job_key = ?`),
  setParsed: db.prepare(`INSERT OR REPLACE INTO parsed_jobs (job_key, parsed_json, parse_quality) VALUES (?, ?, ?)`),
  pruneParsed: db.prepare(`DELETE FROM parsed_jobs WHERE parsed_at < unixepoch() - ?`),

  getCompanyUrl: db.prepare(`SELECT url FROM company_urls WHERE name = ?`),
  setCompanyUrl: db.prepare(`INSERT OR REPLACE INTO company_urls (name, url) VALUES (?, ?)`),
  pruneCompanyUrls: db.prepare(`DELETE FROM company_urls WHERE resolved_at < unixepoch() - ?`),

  getQuota: db.prepare(`SELECT value FROM llm_quota WHERE key = ?`),
  setQuota: db.prepare(`INSERT OR REPLACE INTO llm_quota (key, value) VALUES (?, ?)`),
};

// Parsed jobs cache (30day TTL)

export function getCachedParse(jobKey: string): CachedParse | null {
  const row = sql.getParsed.get(jobKey) as { parsed_json: string; parse_quality: string } | undefined;
  if (!row) return null;
  try {
    const result = ParsedJobSchema.safeParse(JSON.parse(row.parsed_json));
    if (!result.success) return null;
    return { parsed: result.data, quality: row.parse_quality === "quick" ? "quick" : "full" };
  } catch {
    return null;
  }
}

export function setCachedParse(jobKey: string, parsed: ParsedJob, quality: ParseQuality = "full"): void {
  sql.setParsed.run(jobKey, JSON.stringify(parsed), quality);
}

export function pruneParsedCache(maxAgeDays = 30): void {
  const { changes } = sql.pruneParsed.run(maxAgeDays * SECONDS_PER_DAY);
  if (changes > 0) log(`Pruned ${changes} old parsed_jobs entries`);
}

// Company URL cache (90-day TTL)
// Returns undefined if never looked up, null if looked up but no URL found

export function getCachedCompanyUrl(name: string): string | null | undefined {
  const row = sql.getCompanyUrl.get(name) as { url: string | null } | undefined;
  return row === undefined ? undefined : row.url;
}

export function setCachedCompanyUrl(name: string, url: string | null): void {
  sql.setCompanyUrl.run(name, url);
}

export function pruneCompanyUrls(maxAgeDays = 90): void {
  const { changes } = sql.pruneCompanyUrls.run(maxAgeDays * SECONDS_PER_DAY);
  if (changes > 0) log(`Pruned ${changes} old company_urls entries`);
}

// LLM quota (key value store for rate limit state)

export function getLlmQuotaValue(key: string): string | null {
  const row = sql.getQuota.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setLlmQuotaValue(key: string, value: string): void {
  sql.setQuota.run(key, value);
}
