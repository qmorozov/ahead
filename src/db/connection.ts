import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { log } from "../logger";

const DB_DIR = process.env["DB_DIR"] || path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DB_DIR, "bot.db");

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

const migrations: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    chat_id TEXT PRIMARY KEY,
    keywords TEXT NOT NULL DEFAULT '[]',
    exclude_keywords TEXT NOT NULL DEFAULT '[]',
    locations TEXT NOT NULL DEFAULT '[]',
    seniority TEXT NOT NULL DEFAULT '[]',
    check_interval_minutes INTEGER NOT NULL DEFAULT 30,
    max_job_age_days INTEGER NOT NULL DEFAULT 7,
    paused INTEGER NOT NULL DEFAULT 0,
    jobs_sent INTEGER NOT NULL DEFAULT 0
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
  CREATE INDEX IF NOT EXISTS idx_parsed_jobs_at ON parsed_jobs(parsed_at);

  CREATE TABLE IF NOT EXISTS company_urls (
    name TEXT PRIMARY KEY,
    url TEXT,
    resolved_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_company_urls_at ON company_urls(resolved_at);

  CREATE TABLE IF NOT EXISTS llm_quota (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_jobs (
    id TEXT PRIMARY KEY,
    job_json TEXT NOT NULL,
    parsed_json TEXT,
    stored_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pending_jobs_at ON pending_jobs(stored_at);`,

  `ALTER TABLE settings ADD COLUMN roles TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE settings ADD COLUMN min_salary_usd INTEGER NOT NULL DEFAULT 0;`,

  `CREATE TABLE IF NOT EXISTS seen_titles (
    chat_id TEXT NOT NULL,
    norm_key TEXT NOT NULL,
    seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, norm_key)
  );
  CREATE INDEX IF NOT EXISTS idx_seen_titles_at ON seen_titles(seen_at);`,

  `ALTER TABLE settings ADD COLUMN job_types TEXT NOT NULL DEFAULT '[]';`,
];

const currentVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;

if (currentVersion < migrations.length) {
  db.transaction(() => {
    for (let i = currentVersion; i < migrations.length; i++) {
      db.exec(migrations[i]!);
    }
    db.pragma(`user_version = ${migrations.length}`);
  })();
  log(`Database migrated from v${currentVersion} to v${migrations.length}`);
}

export function closeDb(): void {
  db.close();
}
