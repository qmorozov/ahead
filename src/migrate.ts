import fs from "fs";
import path from "path";
import { saveSettings, loadSettings, markSeenBatch, UserSettings } from "./db";
import { log, logError } from "./logger";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_DIR = path.join(DATA_DIR, "settings");
const SEEN_DIR = path.join(DATA_DIR, "seen");

export function migrateFromJson(): void {
  let migrated = 0;

  // Migrate per-user settings files
  if (fs.existsSync(SETTINGS_DIR)) {
    const files = fs.readdirSync(SETTINGS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const chatId = file.replace(".json", "");
      if (loadSettings(chatId)) continue; // already in DB

      try {
        const raw = fs.readFileSync(path.join(SETTINGS_DIR, file), "utf-8");
        const parsed = JSON.parse(raw) as UserSettings;
        if (parsed.paused === undefined) parsed.paused = false;
        parsed.chatId = chatId;
        saveSettings(parsed);
        migrated++;
      } catch (error) {
        logError(`Migration settings/${file}`, error);
      }
    }
  }

  // Migrate legacy single settings.json
  const legacySettings = path.join(DATA_DIR, "settings.json");
  if (fs.existsSync(legacySettings)) {
    try {
      const raw = fs.readFileSync(legacySettings, "utf-8");
      const parsed = JSON.parse(raw) as UserSettings;
      if (parsed.chatId && !loadSettings(parsed.chatId)) {
        if (parsed.paused === undefined) parsed.paused = false;
        saveSettings(parsed);
        migrated++;
      }
    } catch (error) {
      logError("Migration settings.json", error);
    }
  }

  // Migrate per-user seen files
  if (fs.existsSync(SEEN_DIR)) {
    const files = fs.readdirSync(SEEN_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const chatId = file.replace(".json", "");
      try {
        const raw = fs.readFileSync(path.join(SEEN_DIR, file), "utf-8");
        const keys = JSON.parse(raw) as string[];
        if (keys.length > 0) {
          markSeenBatch(chatId, keys);
          migrated++;
        }
      } catch (error) {
        logError(`Migration seen/${file}`, error);
      }
    }
  }

  // Migrate legacy single seen.json
  const legacySeen = path.join(DATA_DIR, "seen.json");
  if (fs.existsSync(legacySeen) && fs.existsSync(legacySettings)) {
    try {
      const settingsRaw = fs.readFileSync(legacySettings, "utf-8");
      const settings = JSON.parse(settingsRaw) as UserSettings;
      const seenRaw = fs.readFileSync(legacySeen, "utf-8");
      const keys = JSON.parse(seenRaw) as string[];
      if (settings.chatId && keys.length > 0) {
        markSeenBatch(settings.chatId, keys);
        migrated++;
      }
    } catch (error) {
      logError("Migration seen.json", error);
    }
  }

  if (migrated > 0) {
    log(`Migrated ${migrated} data file(s) to SQLite.`);
  }
}
