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
      schedulePoll();
    }
  }
});

setOnIntervalChanged(() => schedulePoll());

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function getPollIntervalMs(): number {
  const allSettings = loadAllSettings().filter((s) => isOnboarded(s));
  const minutes =
    allSettings.length > 0
      ? Math.max(
          POLLING.MIN_INTERVAL_MINUTES,
          Math.min(...allSettings.map((s) => s.checkIntervalMinutes)),
        )
      : 30;
  return minutes * 60_000;
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const ms = getPollIntervalMs();
  log(`Next poll in ${ms / 60_000}min.`);

  pollTimer = setTimeout(async function tick() {
    try {
      await pollAllUsers();
    } catch (error) {
      logError("Poll cycle", error);
    }
    if (!shuttingDown) {
      const ms = getPollIntervalMs();
      log(`Next poll in ${ms / 60_000}min.`);
      pollTimer = setTimeout(tick, ms);
    }
  }, ms);
}

const WAL_INTERVAL_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

const walTimer = setInterval(() => {
  try {
    checkpointWal();
  } catch (e) {
    logError("WAL checkpoint", e);
  }
}, WAL_INTERVAL_MS);

const sweepTimer = setInterval(() => {
  sweepStaleWizards();
  sweepStaleInputs();
}, SWEEP_INTERVAL_MS);

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
      schedulePoll();
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

  if (pollTimer) clearTimeout(pollTimer);
  clearInterval(walTimer);
  clearInterval(sweepTimer);

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