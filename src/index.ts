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
import { sweepStaleWizards } from "./bot/wizard";
import { sweepStaleInputs } from "./bot/settings";
import { log, logError } from "./lib/logger";
import { pollAllUsers, pollSingleUser, isPolling } from "./pipeline/polling";
import { initPendingJobs } from "./bot/delivery";
import { sleep } from "./lib/utils";
import { POLLING } from "./constants";

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

setOnWizardComplete(async (chatId) => {
  const settings = loadSettings(chatId);
  if (settings) {
    try {
      await pollSingleUser(settings);
    } catch (error) {
      logError(`Poll [${chatId}]`, error);
    } finally {
      startCron();
    }
  }
});

setOnIntervalChanged(() => startCron());

let cronTask: ScheduledTask | null = null;

function startCron(): void {
  if (cronTask) cronTask.stop();

  const allSettings = loadAllSettings().filter((s) => isOnboarded(s));
  const interval =
    allSettings.length > 0
      ? Math.max(
          POLLING.MIN_INTERVAL_MINUTES,
          Math.min(...allSettings.map((s) => s.checkIntervalMinutes)),
        )
      : 30;

  cronTask = cron.schedule(`*/${interval} * * * *`, () => {
    pollAllUsers().catch((error) => logError("Poll cycle", error));
  });

  log(`Cron tick: every ${interval}min (per-user intervals apply).`);
}

const walCron = cron.schedule("0 * * * *", () => {
  try {
    checkpointWal();
  } catch (e) {
    logError("WAL checkpoint", e);
  }
});

const sweepCron = cron.schedule("*/5 * * * *", () => {
  sweepStaleWizards();
  sweepStaleInputs();
});

bot.api
  .setMyCommands([
    { command: "start", description: "Set up your preferences" },
    { command: "settings", description: "Edit filters" },
  ])
  .catch((e) => logError("setMyCommands", e));

initPendingJobs(bot.api);
bot.start({ onStart: () => log("Bot started polling.") });

const onboarded = loadAllSettings().filter((s) => isOnboarded(s));
if (onboarded.length > 0) {
  log(`${onboarded.length} user(s) found. Starting polling...`);
  (async () => {
    try {
      await pollAllUsers();
    } catch (error) {
      logError("Initial poll", error);
    } finally {
      startCron();
    }
  })();
} else {
  log("No users yet. Waiting for /start in Telegram...");
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received - shutting down...`);

  cronTask?.stop();
  walCron.stop();
  sweepCron.stop();

  const deadline = Date.now() + 10_000;
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
