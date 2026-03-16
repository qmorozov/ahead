import { db } from "./connection";

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
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
  excludeKeywords: string[];
  locations: string[];
  seniority: string[];
  jobTypes: string[];
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
    excludeKeywords: [],
    locations: [],
    seniority: [],
    jobTypes: [],
    minSalaryUsd: 0,
    checkIntervalMinutes: 30,
    maxJobAgeDays: 7,
    paused: false,
    jobsSent: 0,
  };
}

export function isOnboarded(settings: UserSettings): boolean {
  return settings.keywords.length > 0 || settings.roles.length > 0;
}

const stmtGetSettings = db.prepare(`SELECT * FROM settings WHERE chat_id = ?`);
const stmtUpsertSettings = db.prepare(`
  INSERT INTO settings (chat_id, roles, keywords, exclude_keywords, locations, seniority, job_types, min_salary_usd, check_interval_minutes, max_job_age_days, paused, jobs_sent)
  VALUES (@chat_id, @roles, @keywords, @exclude_keywords, @locations, @seniority, @job_types, @min_salary_usd, @check_interval_minutes, @max_job_age_days, @paused, 0)
  ON CONFLICT(chat_id) DO UPDATE SET
    roles = @roles,
    keywords = @keywords,
    exclude_keywords = @exclude_keywords,
    locations = @locations,
    seniority = @seniority,
    job_types = @job_types,
    min_salary_usd = @min_salary_usd,
    check_interval_minutes = @check_interval_minutes,
    max_job_age_days = @max_job_age_days,
    paused = @paused
`);
const stmtAllSettings = db.prepare(`SELECT * FROM settings`);
const stmtIncrementJobsSent = db.prepare(
  `UPDATE settings SET jobs_sent = jobs_sent + ? WHERE chat_id = ?`,
);

function rowToSettings(row: Record<string, unknown>): UserSettings {
  return {
    chatId: row.chat_id as string,
    roles: jsonArray(row.roles),
    keywords: jsonArray(row.keywords),
    excludeKeywords: jsonArray(row.exclude_keywords),
    locations: jsonArray(row.locations),
    seniority: jsonArray(row.seniority),
    jobTypes: jsonArray(row.job_types),
    minSalaryUsd: (row.min_salary_usd as number) ?? 0,
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
    roles: JSON.stringify(settings.roles),
    keywords: JSON.stringify(settings.keywords),
    exclude_keywords: JSON.stringify(settings.excludeKeywords),
    locations: JSON.stringify(settings.locations),
    seniority: JSON.stringify(settings.seniority),
    job_types: JSON.stringify(settings.jobTypes),
    min_salary_usd: settings.minSalaryUsd,
    check_interval_minutes: settings.checkIntervalMinutes,
    max_job_age_days: settings.maxJobAgeDays,
    paused: settings.paused ? 1 : 0,
  });
}

export function loadAllSettings(): UserSettings[] {
  const rows = stmtAllSettings.all() as Record<string, unknown>[];
  return rows.map(rowToSettings);
}

export function incrementJobsSent(chatId: string, count: number): void {
  stmtIncrementJobsSent.run(count, chatId);
}
