import cron, { ScheduledTask } from "node-cron";
import { bot } from "./bot";
import { isOnboarded, loadSettings, loadAllSettings, closeDb } from "./db";
import { registerCommands, setOnUserStarted } from "./commands";
import { log, logError } from "./logger";
import { pollAllUsers, pollSingleUser } from "./polling";
import { migrateFromJson } from "./migrate";
import { restoreWizardSessions } from "./wizard";

let cronTask: ScheduledTask | null = null;

function startCron(): void {
  if (cronTask) {
    cronTask.stop();
  }

  const allSettings = loadAllSettings().filter((s) => isOnboarded(s));
  const interval =
    allSettings.length > 0
      ? Math.max(5, Math.min(...allSettings.map((s) => s.checkIntervalMinutes)))
      : 30;

  cronTask = cron.schedule(`*/${interval} * * * *`, () => {
    pollAllUsers().catch((error) => logError("Poll cycle", error));
  });

  log(`Cron started: every ${interval} minutes.`);
}

migrateFromJson();
restoreWizardSessions();
registerCommands();

setOnUserStarted((chatId: string) => {
  const settings = loadSettings(chatId);
  if (settings) {
    pollSingleUser(settings)
      .catch((error) => logError(`Poll [${chatId}]`, error))
      .finally(() => startCron());
  }
});

const existing = loadAllSettings().filter((s) => isOnboarded(s));
if (existing.length > 0) {
  log(`${existing.length} user(s) found. Starting polling...`);
  pollAllUsers().then(() => startCron());
} else {
  log("No users yet. Waiting for /start in Telegram...");
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received. Shutting down...`);

  if (cronTask) cronTask.stop();
  bot.stopPolling();
  closeDb();

  log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logError("UnhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  logError("UncaughtException", error);
  shutdown("UncaughtException");
});
