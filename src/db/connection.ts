import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "../config";
import { log } from "../lib/logger";

const DB_PATH = path.join(config.dbDir, "bot.db");

if (!fs.existsSync(config.dbDir)) fs.mkdirSync(config.dbDir, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL"); // safe with WAL, faster than FULL
db.pragma("busy_timeout = 5000");
db.pragma("cache_size = -20000"); // 20 MB (negative = KB)
db.pragma("mmap_size = 67108864"); // 64 MB
db.pragma("temp_store = MEMORY");

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

  `CREATE TABLE IF NOT EXISTS boards (
    slug TEXT NOT NULL,
    platform TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    job_count INTEGER NOT NULL DEFAULT 0,
    last_checked INTEGER,
    PRIMARY KEY (slug, platform)
  );`,

  `ALTER TABLE boards ADD COLUMN etag TEXT;`,

  `ALTER TABLE boards ADD COLUMN consecutive_304s INTEGER NOT NULL DEFAULT 0;`,

  `UPDATE settings SET max_job_age_days = 2 WHERE max_job_age_days = 7;`,

  `ALTER TABLE pending_jobs ADD COLUMN chat_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_pending_jobs_chat ON pending_jobs(chat_id);`,

  `ALTER TABLE settings ADD COLUMN work_arrangement TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE settings ADD COLUMN accepted_languages TEXT NOT NULL DEFAULT '["English"]';
  ALTER TABLE settings ADD COLUMN enabled_sources TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE settings ADD COLUMN primary_stack TEXT NOT NULL DEFAULT '[]';`,

  // Fix bad defaults from migration 9: 'any' is not valid JSON, and 'en' should be 'English'
  `UPDATE settings SET work_arrangement = '[]' WHERE work_arrangement = 'any';
  UPDATE settings SET accepted_languages = '["English"]' WHERE accepted_languages = '["en"]';`,

  `CREATE TABLE IF NOT EXISTS deferred_jobs (
    chat_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    cycles INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, job_key)
  );`,

  `ALTER TABLE parsed_jobs ADD COLUMN parse_quality TEXT NOT NULL DEFAULT 'full';`,

  `CREATE TABLE IF NOT EXISTS source_health (
    source TEXT PRIMARY KEY,
    last_success_at INTEGER,
    last_job_count INTEGER,
    fail_streak INTEGER NOT NULL DEFAULT 0
  );`,
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

export function checkpointWal(): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

export function closeDb(): void {
  db.close();
}
