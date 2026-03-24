import { z } from "zod";
import { db } from "./connection";
import { warn } from "../lib/logger";

const SettingsRowSchema = z.object({
  chat_id: z.string(),
  roles: z.string().default("[]"),
  keywords: z.string().default("[]"),
  primary_stack: z.string().default("[]"),
  exclude_keywords: z.string().default("[]"),
  locations: z.string().default("[]"),
  seniority: z.string().default("[]"),
  job_types: z.string().default("[]"),
  work_arrangement: z.string().default("[]"),
  accepted_languages: z.string().default('["English"]'),
  enabled_sources: z.string().default("[]"),
  min_salary_usd: z.number().default(0),
  check_interval_minutes: z.number().default(30),
  max_job_age_days: z.number().default(2),
  paused: z.number().default(0),
  jobs_sent: z.number().default(0),
});

function jsonArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export interface UserSettings {
  chatId: string;
  roles: string[];
  keywords: string[];
  primaryStack: string[];
  excludeKeywords: string[];
  locations: string[];
  seniority: string[];
  jobTypes: string[];
  workArrangement: string[];
  acceptedLanguages: string[];
  enabledSources: string[];
  minSalaryUsd: number;
  checkIntervalMinutes: number;
  maxJobAgeDays: number;
  paused: boolean;
  jobsSent: number;
}

export function createDefaultSettings(chatId: string): UserSettings {
  return {
    chatId,
    roles: [],
    keywords: [],
    primaryStack: [],
    excludeKeywords: [],
    locations: [],
    seniority: [],
    jobTypes: [],
    workArrangement: [],
    acceptedLanguages: ["English"],
    enabledSources: [],
    minSalaryUsd: 0,
    checkIntervalMinutes: 30,
    maxJobAgeDays: 2,
    paused: false,
    jobsSent: 0,
  };
}

export function isOnboarded(settings: UserSettings): boolean {
  return settings.keywords.length > 0 || settings.roles.length > 0;
}

const sql = {
  get: db.prepare(`SELECT * FROM settings WHERE chat_id = ?`),
  getAll: db.prepare(`SELECT * FROM settings`),
  getOnboarded: db.prepare(`SELECT * FROM settings WHERE keywords != '[]' OR roles != '[]'`),
  upsert: db.prepare(`
    INSERT INTO settings (chat_id, roles, keywords, primary_stack, exclude_keywords, locations, seniority, job_types,
      work_arrangement, accepted_languages, enabled_sources, min_salary_usd, check_interval_minutes, max_job_age_days, paused, jobs_sent)
    VALUES (@chat_id, @roles, @keywords, @primary_stack, @exclude_keywords, @locations, @seniority, @job_types,
      @work_arrangement, @accepted_languages, @enabled_sources, @min_salary_usd, @check_interval_minutes, @max_job_age_days, @paused, 0)
    ON CONFLICT(chat_id) DO UPDATE SET
      roles = @roles, keywords = @keywords, primary_stack = @primary_stack, exclude_keywords = @exclude_keywords,
      locations = @locations, seniority = @seniority, job_types = @job_types,
      work_arrangement = @work_arrangement, accepted_languages = @accepted_languages, enabled_sources = @enabled_sources,
      min_salary_usd = @min_salary_usd, check_interval_minutes = @check_interval_minutes,
      max_job_age_days = @max_job_age_days, paused = @paused
  `),
  incrementJobsSent: db.prepare(`UPDATE settings SET jobs_sent = jobs_sent + ? WHERE chat_id = ?`),
  pause: db.prepare(`UPDATE settings SET paused = 1 WHERE chat_id = ?`),
};

function rowToSettings(row: z.infer<typeof SettingsRowSchema>): UserSettings {
  return {
    chatId: row.chat_id,
    roles: jsonArray(row.roles),
    keywords: jsonArray(row.keywords),
    primaryStack: jsonArray(row.primary_stack),
    excludeKeywords: jsonArray(row.exclude_keywords),
    locations: jsonArray(row.locations),
    seniority: jsonArray(row.seniority),
    jobTypes: jsonArray(row.job_types),
    workArrangement: jsonArray(row.work_arrangement),
    acceptedLanguages: jsonArray(row.accepted_languages),
    enabledSources: jsonArray(row.enabled_sources),
    minSalaryUsd: row.min_salary_usd,
    checkIntervalMinutes: row.check_interval_minutes,
    maxJobAgeDays: row.max_job_age_days,
    paused: row.paused === 1,
    jobsSent: row.jobs_sent,
  };
}

function parseRows(rows: unknown[]): UserSettings[] {
  const result: UserSettings[] = [];
  for (const raw of rows) {
    const parsed = SettingsRowSchema.safeParse(raw);
    if (parsed.success) {
      result.push(rowToSettings(parsed.data));
    } else {
      warn(`Skipping invalid settings row: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
  }
  return result;
}

export function loadSettings(chatId: string): UserSettings | null {
  const row = sql.get.get(chatId);
  if (!row) return null;
  const parsed = SettingsRowSchema.safeParse(row);
  if (!parsed.success) {
    warn(`Invalid settings row for ${chatId}: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    return null;
  }
  return rowToSettings(parsed.data);
}

export function saveSettings(settings: UserSettings): void {
  sql.upsert.run({
    chat_id: settings.chatId,
    roles: JSON.stringify(settings.roles),
    keywords: JSON.stringify(settings.keywords),
    primary_stack: JSON.stringify(settings.primaryStack),
    exclude_keywords: JSON.stringify(settings.excludeKeywords),
    locations: JSON.stringify(settings.locations),
    seniority: JSON.stringify(settings.seniority),
    job_types: JSON.stringify(settings.jobTypes),
    work_arrangement: JSON.stringify(settings.workArrangement),
    accepted_languages: JSON.stringify(settings.acceptedLanguages),
    enabled_sources: JSON.stringify(settings.enabledSources),
    min_salary_usd: settings.minSalaryUsd,
    check_interval_minutes: settings.checkIntervalMinutes,
    max_job_age_days: settings.maxJobAgeDays,
    paused: settings.paused ? 1 : 0,
  });
}

export function loadAllSettings(): UserSettings[] {
  return parseRows(sql.getAll.all());
}

export function loadOnboardedSettings(): UserSettings[] {
  return parseRows(sql.getOnboarded.all());
}

export function incrementJobsSent(chatId: string, count: number): void {
  sql.incrementJobsSent.run(count, chatId);
}

// called when telegram returns 403 (user blocked bot)
export function markUserBlocked(chatId: string): void {
  sql.pause.run(chatId);
}

const deleteStatements = {
  seenJobs: db.prepare(`DELETE FROM seen_jobs WHERE chat_id = ?`),
  seenTitles: db.prepare(`DELETE FROM seen_titles WHERE chat_id = ?`),
  pendingJobs: db.prepare(`DELETE FROM pending_jobs WHERE chat_id = ?`),
  deferredJobs: db.prepare(`DELETE FROM deferred_jobs WHERE chat_id = ?`),
  feedback: db.prepare(`DELETE FROM feedback WHERE chat_id = ?`),
  settings: db.prepare(`DELETE FROM settings WHERE chat_id = ?`),
};

const deleteUserDataTx = db.transaction((chatId: string) => {
  deleteStatements.seenJobs.run(chatId);
  deleteStatements.seenTitles.run(chatId);
  deleteStatements.pendingJobs.run(chatId);
  deleteStatements.deferredJobs.run(chatId);
  deleteStatements.feedback.run(chatId);
  deleteStatements.settings.run(chatId);
});

export function deleteUserData(chatId: string): void {
  deleteUserDataTx(chatId);
}
