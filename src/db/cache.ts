import { db } from "./connection";
import { ParsedJob, ParsedJobSchema } from "../types";
import { log } from "../logger";

const SECONDS_PER_DAY = 86_400;

const stmtGetParsed = db.prepare(`SELECT parsed_json FROM parsed_jobs WHERE job_key = ?`);
const stmtSetParsed = db.prepare(`
  INSERT OR REPLACE INTO parsed_jobs (job_key, parsed_json) VALUES (?, ?)
`);
const stmtPruneParsed = db.prepare(`
  DELETE FROM parsed_jobs WHERE parsed_at < unixepoch() - ?
`);

export function getCachedParse(jobKey: string): ParsedJob | null {
  const row = stmtGetParsed.get(jobKey) as { parsed_json: string } | undefined;
  if (!row) return null;
  try {
    const result = ParsedJobSchema.safeParse(JSON.parse(row.parsed_json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function setCachedParse(jobKey: string, parsed: ParsedJob): void {
  stmtSetParsed.run(jobKey, JSON.stringify(parsed));
}

export function pruneParsedCache(maxAgeDays: number = 30): void {
  const result = stmtPruneParsed.run(maxAgeDays * SECONDS_PER_DAY);
  if (result.changes > 0) {
    log(`Pruned ${result.changes} old parsed_jobs entries`);
  }
}

const stmtGetCompanyUrl = db.prepare(`SELECT url FROM company_urls WHERE name = ?`);
const stmtSetCompanyUrl = db.prepare(
  `INSERT OR REPLACE INTO company_urls (name, url) VALUES (?, ?)`,
);
const stmtPruneCompanyUrls = db.prepare(`
  DELETE FROM company_urls WHERE resolved_at < unixepoch() - ?
`);

export function getCachedCompanyUrl(name: string): string | null | undefined {
  const row = stmtGetCompanyUrl.get(name) as { url: string | null } | undefined;
  if (!row) return undefined;
  return row.url;
}

export function setCachedCompanyUrl(name: string, url: string | null): void {
  stmtSetCompanyUrl.run(name, url);
}

export function pruneCompanyUrls(maxAgeDays: number = 90): void {
  const result = stmtPruneCompanyUrls.run(maxAgeDays * SECONDS_PER_DAY);
  if (result.changes > 0) log(`Pruned ${result.changes} old company_urls entries`);
}

const stmtGetQuota = db.prepare(`SELECT value FROM llm_quota WHERE key = ?`);
const stmtSetQuota = db.prepare(`INSERT OR REPLACE INTO llm_quota (key, value) VALUES (?, ?)`);

export function getLlmQuotaValue(key: string): string | null {
  const row = stmtGetQuota.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setLlmQuotaValue(key: string, value: string): void {
  stmtSetQuota.run(key, value);
}
