import cron, { ScheduledTask } from "node-cron";
import { GrammyError } from "grammy";
import { bot } from "./bot/instance";
import {
  isOnboarded,
  loadSettings,
  loadAllSettings,
  closeDb,
  checkpointWal,
  markUserBlocked,
} from "./db";
import { handlers, setOnWizardComplete, setOnIntervalChanged } from "./bot/handlers";
import { log, logError } from "./lib/logger";
import { pollAllUsers, pollSingleUser, isPolling } from "./pipeline/polling";
import { sleep } from "./lib/utils";

// Bot setup

bot.catch((err) => {
  const error = err.error;
  // User blocked the bot - stop sending them jobs
  if (error instanceof GrammyError && error.error_code === 403) {
    const chatId = String(err.ctx.chat?.id ?? "");
    if (chatId) {
      log(`User ${chatId} blocked the bot, pausing delivery.`);
      markUserBlocked(chatId);
    }
    return;
  }
  logError("Telegram", error);
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

// Scheduling

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

// Hourly WAL checkpoint to keep the WAL file from growing indefinitely
const walCron = cron.schedule("0 * * * *", () => {
  try {
    checkpointWal();
  } catch (e) {
    logError("WAL checkpoint", e);
  }
});

// Startup

bot.api
  .setMyCommands([
    { command: "start", description: "Set up your preferences" },
    { command: "settings", description: "Edit filters" },
  ])
  .catch((e) => logError("setMyCommands", e));

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

// Shutdown

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — shutting down...`);

  cronTask?.stop();
  walCron.stop();

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (isPolling() && Date.now() < deadline) await sleep(200);
  if (isPolling()) log("Shutdown deadline reached, forcing exit.");

  bot.stop();
  checkpointWal();
  closeDb();

  log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("unhandledRejection", (reason) => logError("UnhandledRejection", reason));
process.on("uncaughtException", (error) => {
  logError("UncaughtException", error);
  shutdown("UncaughtException");
});
