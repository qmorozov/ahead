import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { Job, ParsedJob, ParsedJobSchema } from "./types";
import { log } from "./logger";

export interface UserSettings {
  chatId: string;
  keywords: string[];
  excludeKeywords: string[];
  locations: string[];
  seniority: string[];
  checkIntervalMinutes: number;
  maxJobAgeDays: number;
  paused: boolean;
  jobsSent: number;
}

export function createDefaultSettings(chatId: string): UserSettings {
  return {
    chatId,
    keywords: [],
    excludeKeywords: [],
    locations: [],
    seniority: [],
    checkIntervalMinutes: 30,
    maxJobAgeDays: 7,
    paused: false,
    jobsSent: 0,
  };
}

export function isOnboarded(settings: UserSettings): boolean {
  return settings.keywords.length > 0;
}

export function formatSettings(settings: UserSettings): string {
  const fmt = (arr: string[], fallback: string) => (arr.length > 0 ? arr.join(", ") : fallback);

  return [
    `Status · ${settings.paused ? "paused" : "active"}`,
    `Keywords · ${fmt(settings.keywords, "—")}`,
    `Exclude · ${fmt(settings.excludeKeywords, "—")}`,
    `Locations · ${fmt(settings.locations, "any")}`,
    `Seniority · ${fmt(settings.seniority, "any")}`,
    `Interval · ${settings.checkIntervalMinutes}min`,
    `Max age · ${settings.maxJobAgeDays > 0 ? `${settings.maxJobAgeDays}d` : "off"}`,
    `Jobs sent · ${settings.jobsSent}`,
  ].join("\n");
}

export function parseCommaSeparated(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function jobKey(job: Job): string {
  return `${job.source.toLowerCase()}::${job.id}`;
}

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "bot.db");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    chat_id TEXT PRIMARY KEY,
    keywords TEXT NOT NULL DEFAULT '[]',
    exclude_keywords TEXT NOT NULL DEFAULT '[]',
    locations TEXT NOT NULL DEFAULT '[]',
    check_interval_minutes INTEGER NOT NULL DEFAULT 30,
    max_job_age_days INTEGER NOT NULL DEFAULT 7,
    paused INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS seen_jobs (
    chat_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, job_key)
  );

  CREATE INDEX IF NOT EXISTS idx_seen_jobs_chat ON seen_jobs(chat_id);

  CREATE TABLE IF NOT EXISTS parsed_jobs (
    job_key TEXT PRIMARY KEY,
    parsed_json TEXT NOT NULL,
    parsed_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS company_urls (
    name TEXT PRIMARY KEY,
    url TEXT,
    resolved_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS wizard_sessions (
    chat_id TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    message_id INTEGER,
    keywords TEXT NOT NULL DEFAULT '[]',
    exclude_keywords TEXT NOT NULL DEFAULT '[]',
    locations TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

for (const migration of [
  `ALTER TABLE settings ADD COLUMN seniority TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE settings ADD COLUMN jobs_sent INTEGER NOT NULL DEFAULT 0`,
]) {
  try {
    db.exec(migration);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("duplicate column")) throw err;
  }
}

const stmtGetSettings = db.prepare(`SELECT * FROM settings WHERE chat_id = ?`);
const stmtUpsertSettings = db.prepare(`
  INSERT INTO settings (chat_id, keywords, exclude_keywords, locations, seniority, check_interval_minutes, max_job_age_days, paused, jobs_sent)
  VALUES (@chat_id, @keywords, @exclude_keywords, @locations, @seniority, @check_interval_minutes, @max_job_age_days, @paused, 0)
  ON CONFLICT(chat_id) DO UPDATE SET
    keywords = @keywords,
    exclude_keywords = @exclude_keywords,
    locations = @locations,
    seniority = @seniority,
    check_interval_minutes = @check_interval_minutes,
    max_job_age_days = @max_job_age_days,
    paused = @paused
`);
const stmtAllSettings = db.prepare(`SELECT * FROM settings`);

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(value as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToSettings(row: Record<string, unknown>): UserSettings {
  return {
    chatId: row.chat_id as string,
    keywords: parseJsonArray(row.keywords),
    excludeKeywords: parseJsonArray(row.exclude_keywords),
    locations: parseJsonArray(row.locations),
    seniority: parseJsonArray(row.seniority),
    checkIntervalMinutes: row.check_interval_minutes as number,
    maxJobAgeDays: row.max_job_age_days as number,
    paused: (row.paused as number) === 1,
    jobsSent: (row.jobs_sent as number) ?? 0,
  };
}

export function loadSettings(chatId: string): UserSettings | null {
  const row = stmtGetSettings.get(chatId) as Record<string, unknown> | undefined;
  return row ? rowToSettings(row) : null;
}

export function saveSettings(settings: UserSettings): void {
  stmtUpsertSettings.run({
    chat_id: settings.chatId,
    keywords: JSON.stringify(settings.keywords),
    exclude_keywords: JSON.stringify(settings.excludeKeywords),
    locations: JSON.stringify(settings.locations),
    seniority: JSON.stringify(settings.seniority),
    check_interval_minutes: settings.checkIntervalMinutes,
    max_job_age_days: settings.maxJobAgeDays,
    paused: settings.paused ? 1 : 0,
  });
}

export function loadAllSettings(): UserSettings[] {
  const rows = stmtAllSettings.all() as Record<string, unknown>[];
  return rows.map(rowToSettings);
}

const stmtIsSeen = db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? AND job_key = ?`);
const stmtMarkSeen = db.prepare(`INSERT OR IGNORE INTO seen_jobs (chat_id, job_key) VALUES (?, ?)`);
const stmtHasAnySeen = db.prepare(`SELECT 1 FROM seen_jobs WHERE chat_id = ? LIMIT 1`);
const stmtPruneSeen = db.prepare(`
  DELETE FROM seen_jobs WHERE chat_id = ? AND rowid NOT IN (
    SELECT rowid FROM seen_jobs WHERE chat_id = ? ORDER BY seen_at DESC LIMIT 10000
  )
`);

export function isSeen(chatId: string, jobKey: string): boolean {
  return stmtIsSeen.get(chatId, jobKey) !== undefined;
}

export function markSeen(chatId: string, jobKey: string): void {
  stmtMarkSeen.run(chatId, jobKey);
}

const markSeenBatchTx = db.transaction((chatId: string, keys: string[]) => {
  for (const key of keys) {
    stmtMarkSeen.run(chatId, key);
  }
});

export function markSeenBatch(chatId: string, keys: string[]): void {
  markSeenBatchTx(chatId, keys);
}

export function isFirstRun(chatId: string): boolean {
  return stmtHasAnySeen.get(chatId) === undefined;
}

export function pruneSeen(chatId: string): void {
  stmtPruneSeen.run(chatId, chatId);
}

const stmtGetParsed = db.prepare(`SELECT parsed_json FROM parsed_jobs WHERE job_key = ?`);
const stmtSetParsed = db.prepare(`
  INSERT OR REPLACE INTO parsed_jobs (job_key, parsed_json) VALUES (?, ?)
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

const stmtGetCompanyUrl = db.prepare(`SELECT url FROM company_urls WHERE name = ?`);
const stmtSetCompanyUrl = db.prepare(
  `INSERT OR REPLACE INTO company_urls (name, url) VALUES (?, ?)`,
);

export function getCachedCompanyUrl(name: string): string | null | undefined {
  const row = stmtGetCompanyUrl.get(name) as { url: string | null } | undefined;
  if (!row) return undefined; // not in cache
  return row.url; // null means "resolved but not found"
}

export function setCachedCompanyUrl(name: string, url: string | null): void {
  stmtSetCompanyUrl.run(name, url);
}

const stmtPruneParsed = db.prepare(`
  DELETE FROM parsed_jobs WHERE parsed_at < unixepoch() - ?
`);
const stmtPruneCompanyUrls = db.prepare(`
  DELETE FROM company_urls WHERE resolved_at < unixepoch() - ?
`);

export function pruneParsedCache(maxAgeDays: number = 30): void {
  const result = stmtPruneParsed.run(maxAgeDays * 86400);
  if (result.changes > 0) {
    log(`Pruned ${result.changes} old parsed_jobs entries`);
  }
}

export function pruneCompanyUrls(maxAgeDays: number = 90): void {
  const result = stmtPruneCompanyUrls.run(maxAgeDays * 86400);
  if (result.changes > 0) {
    log(`Pruned ${result.changes} old company_urls entries`);
  }
}

interface WizardSessionRow {
  chatId: string;
  step: string;
  messageId: number | null;
  keywords: string[];
  excludeKeywords: string[];
  locations: string[];
}

const stmtUpsertWizard = db.prepare(`
  INSERT INTO wizard_sessions (chat_id, step, message_id, keywords, exclude_keywords, locations, updated_at)
  VALUES (@chat_id, @step, @message_id, @keywords, @exclude_keywords, @locations, unixepoch())
  ON CONFLICT(chat_id) DO UPDATE SET
    step = @step, message_id = @message_id, keywords = @keywords,
    exclude_keywords = @exclude_keywords, locations = @locations, updated_at = unixepoch()
`);
const stmtDeleteWizard = db.prepare(`DELETE FROM wizard_sessions WHERE chat_id = ?`);
const stmtAllWizards = db.prepare(`SELECT * FROM wizard_sessions`);

function rowToWizard(row: Record<string, unknown>): WizardSessionRow {
  return {
    chatId: row.chat_id as string,
    step: row.step as string,
    messageId: row.message_id as number | null,
    keywords: parseJsonArray(row.keywords),
    excludeKeywords: parseJsonArray(row.exclude_keywords),
    locations: parseJsonArray(row.locations),
  };
}

export function saveWizardSession(session: WizardSessionRow): void {
  stmtUpsertWizard.run({
    chat_id: session.chatId,
    step: session.step,
    message_id: session.messageId,
    keywords: JSON.stringify(session.keywords),
    exclude_keywords: JSON.stringify(session.excludeKeywords),
    locations: JSON.stringify(session.locations),
  });
}

export function deleteWizardSession(chatId: string): void {
  stmtDeleteWizard.run(chatId);
}

export function loadAllWizardSessions(): WizardSessionRow[] {
  const rows = stmtAllWizards.all() as Record<string, unknown>[];
  return rows.map(rowToWizard);
}

const stmtIncrementJobsSent = db.prepare(
  `UPDATE settings SET jobs_sent = jobs_sent + ? WHERE chat_id = ?`,
);

export function incrementJobsSent(chatId: string, count: number): void {
  stmtIncrementJobsSent.run(count, chatId);
}

export function closeDb(): void {
  db.close();
}
