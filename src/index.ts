import cron, { ScheduledTask } from "node-cron";
import { bot } from "./bot";
import { isOnboarded, loadSettings, loadAllSettings, closeDb } from "./db";
import { handlers, setOnWizardComplete, setOnIntervalChanged } from "./handlers";
import { log, logError } from "./logger";
import { pollAllUsers, pollSingleUser } from "./polling";

let cronTask: ScheduledTask | null = null;

function startCron(): void {
  if (cronTask) cronTask.stop();

  const allSettings = loadAllSettings().filter((s) => isOnboarded(s));
  const interval =
    allSettings.length > 0
      ? Math.max(5, Math.min(...allSettings.map((s) => s.checkIntervalMinutes)))
      : 30;

  cronTask = cron.schedule(`*/${interval} * * * *`, () => {
    pollAllUsers().catch((error) => logError("Poll cycle", error));
  });

  log(`Cron tick: every ${interval}min (per-user intervals apply).`);
}

bot.catch((err) => {
  logError("Telegram", err.error);
});

bot.use(handlers);

setOnWizardComplete((chatId) => {
  const settings = loadSettings(chatId);
  if (settings) {
    pollSingleUser(settings)
      .catch((error) => logError(`Poll [${chatId}]`, error))
      .finally(() => startCron());
  }
});

setOnIntervalChanged(() => startCron());

bot.api.setMyCommands([
  { command: "start", description: "Set up your preferences" },
  { command: "settings", description: "Edit filters" },
  { command: "status", description: "See recent activity" },
  { command: "cancel", description: "Cancel current action" },
]).catch(() => {});
bot.start({ onStart: () => log("Bot started polling.") });

const onboarded = loadAllSettings().filter((s) => isOnboarded(s));
if (onboarded.length > 0) {
  log(`${onboarded.length} user(s) found. Starting polling...`);
  pollAllUsers()
    .catch((error) => logError("Initial poll", error))
    .then(() => startCron());
} else {
  log("No users yet. Waiting for /start in Telegram...");
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received. Shutting down...`);

  if (cronTask) cronTask.stop();
  bot.stop();
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
