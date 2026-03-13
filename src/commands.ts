import { bot, sendJob, getStoredJob } from "./bot";
import {
  formatSettings,
  isOnboarded,
  UserSettings,
  loadSettings,
  saveSettings,
  parseCommaSeparated,
} from "./db";
import {
  startWizard,
  handleWizardCallback,
  handleWizardTextInput,
  isWizardActive,
  cancelWizard,
  setOnWizardComplete,
} from "./wizard";
import { logError } from "./logger";

type SettingKey =
  | "keywords"
  | "excludeKeywords"
  | "locations"
  | "checkIntervalMinutes"
  | "maxJobAgeDays";
type ArraySettingKey = "keywords" | "excludeKeywords" | "locations";

const waitingForInput = new Map<string, SettingKey>();

const PAUSE_MSG = "Paused. You won't get new jobs until you resume.";
const RESUME_MSG = "Resumed! You'll get new jobs again.";

function buildSettingsKeyboard(settings: UserSettings) {
  return {
    inline_keyboard: [
      [
        { text: "Keywords", callback_data: "set:keywords" },
        { text: "Exclude", callback_data: "set:excludeKeywords" },
      ],
      [
        { text: "Locations", callback_data: "set:locations" },
        { text: "Interval", callback_data: "set:checkIntervalMinutes" },
      ],
      [
        { text: "Max age", callback_data: "set:maxJobAgeDays" },
        { text: settings.paused ? "▶ Resume" : "⏸ Pause", callback_data: "set:togglePause" },
      ],
    ],
  };
}

const LABELS: Record<SettingKey, string> = {
  keywords: "Keywords",
  excludeKeywords: "Exclude",
  locations: "Locations",
  checkIntervalMinutes: "Interval",
  maxJobAgeDays: "Max age",
};

const INPUT_HINTS: Record<ArraySettingKey, string> = {
  keywords: "e.g. react, frontend, product manager",
  excludeKeywords: "e.g. intern, unpaid, senior",
  locations: "e.g. berlin, remote, canada",
};

function buildArrayEditKeyboard(
  key: ArraySettingKey,
  items: string[],
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < items.length; i += 2) {
    const row = items.slice(i, i + 2).map((item) => ({
      text: `✕ ${item}`,
      callback_data: `set:rm:${key}:${item}`,
    }));
    rows.push(row);
  }

  rows.push([{ text: "← Back", callback_data: "set:back" }]);

  return { inline_keyboard: rows };
}

function replyKeyboard(paused: boolean) {
  return {
    keyboard: [[{ text: "⚙️ Settings" }, { text: paused ? "▶ Resume" : "⏸ Pause" }]],
    resize_keyboard: true,
  };
}

function sendSettingsMenu(chatId: string, settings: UserSettings): void {
  const text = `⚙️ Settings\n\n${formatSettings(settings)}`;
  bot.sendMessage(chatId, text, {
    reply_markup: buildSettingsKeyboard(settings),
  });
}

function sendArrayEditor(chatId: string, key: ArraySettingKey, settings: UserSettings): void {
  const items = settings[key];
  const label = LABELS[key];

  const lines = [`⚙️ ${label}\n`];
  if (items.length > 0) {
    lines.push(`${items.join(", ")}\n`);
    lines.push("Tap to remove. Type to add more.");
  } else {
    lines.push("Nothing here yet. Type to add, comma-separated.");
  }

  bot.sendMessage(chatId, lines.join("\n"), {
    reply_markup: {
      ...buildArrayEditKeyboard(key, items),
      input_field_placeholder: INPUT_HINTS[key],
    } as ReturnType<typeof buildArrayEditKeyboard>,
  });
}

function togglePause(chatId: string): UserSettings | null {
  const settings = loadSettings(chatId);
  if (!settings) return null;

  settings.paused = !settings.paused;
  saveSettings(settings);
  return settings;
}

let onUserStarted: ((chatId: string) => void) | null = null;
let onSettingsChanged: (() => void) | null = null;

export function setOnUserStarted(cb: (chatId: string) => void): void {
  onUserStarted = cb;
}

export function setOnSettingsChanged(cb: () => void): void {
  onSettingsChanged = cb;
}

export function registerCommands(): void {
  bot.deleteMyCommands();

  setOnWizardComplete((chatId: string) => {
    if (onUserStarted) {
      onUserStarted(chatId);
    }
  });

  bot.onText(/\/start/, (msg) => {
    const chatId = String(msg.chat.id);

    if (isWizardActive(chatId)) return;

    const settings = loadSettings(chatId);
    if (settings && isOnboarded(settings)) {
      bot.sendMessage(chatId, "You're already set up. Use /settings to make changes.", {
        reply_markup: replyKeyboard(settings.paused),
      });
      return;
    }

    startWizard(chatId).catch((e) => logError("startWizard", e));
  });

  bot.onText(/\/settings/, (msg) => {
    const chatId = String(msg.chat.id);
    const settings = loadSettings(chatId);

    if (!settings || !isOnboarded(settings)) {
      bot.sendMessage(chatId, "Run /start first to set up your preferences.");
      return;
    }

    sendSettingsMenu(chatId, settings);
  });

  bot.onText(/\/cancel/, (msg) => {
    const chatId = String(msg.chat.id);

    if (isWizardActive(chatId)) {
      cancelWizard(chatId);
      bot.sendMessage(chatId, "Cancelled. Send /start to try again.");
      return;
    }

    waitingForInput.delete(chatId);

    const settings = loadSettings(chatId);
    if (settings) {
      sendSettingsMenu(chatId, settings);
    } else {
      bot.sendMessage(chatId, "Cancelled.");
    }
  });

  bot.on("callback_query", (query) => {
    if (!query.data || !query.message) return;

    const chatId = String(query.message.chat.id);

    if (query.data.startsWith("job:")) {
      const id = query.data.replace("job:", "");
      const stored = getStoredJob(id);

      if (!stored) {
        bot.answerCallbackQuery(query.id, { text: "This job listing has expired." });
        return;
      }

      bot.answerCallbackQuery(query.id);
      sendJob(chatId, stored.job, stored.parsed).catch((e) => logError("jobDetail", e));
      return;
    }

    if (query.data.startsWith("wiz:")) {
      handleWizardCallback(chatId, query.data, query.id).catch((e) =>
        logError("wizardCallback", e),
      );
      return;
    }

    if (query.data === "set:togglePause") {
      const settings = togglePause(chatId);
      if (!settings) {
        bot.answerCallbackQuery(query.id, { text: "Run /start first." });
        return;
      }
      bot.answerCallbackQuery(query.id, {
        text: settings.paused ? PAUSE_MSG : RESUME_MSG,
      });
      sendSettingsMenu(chatId, settings);
      return;
    }

    // Back to settings menu
    if (query.data === "set:back") {
      const key = waitingForInput.get(chatId);
      waitingForInput.delete(chatId);
      const settings = loadSettings(chatId);
      if (settings) {
        if (key) {
          bot.answerCallbackQuery(query.id, { text: `${LABELS[key]} saved.` });
        } else {
          bot.answerCallbackQuery(query.id);
        }
        sendSettingsMenu(chatId, settings);
      }
      return;
    }

    // Remove item from array setting
    if (query.data.startsWith("set:rm:")) {
      const parts = query.data.replace("set:rm:", "").split(":");
      const key = parts[0] as ArraySettingKey;
      const value = parts.slice(1).join(":");
      const settings = loadSettings(chatId);

      if (!settings) {
        bot.answerCallbackQuery(query.id, { text: "Run /start first." });
        return;
      }

      settings[key] = settings[key].filter((item) => item !== value);
      saveSettings(settings);
      bot.answerCallbackQuery(query.id, { text: `Removed "${value}"` });
      sendArrayEditor(chatId, key, settings);
      return;
    }

    // Open setting editor
    if (query.data.startsWith("set:")) {
      const key = query.data.replace("set:", "") as SettingKey;
      const settings = loadSettings(chatId);

      if (!settings) {
        bot.answerCallbackQuery(query.id, { text: "Run /start first." });
        return;
      }

      bot.answerCallbackQuery(query.id);

      if (key === "keywords" || key === "excludeKeywords" || key === "locations") {
        waitingForInput.set(chatId, key);
        sendArrayEditor(chatId, key, settings);
        return;
      }

      waitingForInput.set(chatId, key);
      const current = settings[key];
      const prompt =
        key === "checkIntervalMinutes"
          ? `⚙️ Interval\n\nCurrently checking every ${current} minutes.\nType a new number.`
          : `⚙️ Max age\n\nCurrently ${current} days.\nType a new number, or 0 for no limit.`;

      bot.sendMessage(chatId, prompt, {
        reply_markup: {
          inline_keyboard: [[{ text: "← Back", callback_data: "set:back" }]],
        },
      });
    }
  });

  bot.on("message", (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;

    if (!text) return;

    // Handle reply keyboard buttons
    if (text === "⚙️ Settings") {
      const settings = loadSettings(chatId);
      if (settings && isOnboarded(settings)) {
        sendSettingsMenu(chatId, settings);
      } else {
        bot.sendMessage(chatId, "Run /start first to set up your preferences.");
      }
      return;
    }

    if (text === "⏸ Pause" || text === "▶ Resume") {
      const settings = togglePause(chatId);
      if (!settings) return;

      bot.sendMessage(chatId, settings.paused ? PAUSE_MSG : RESUME_MSG, {
        reply_markup: replyKeyboard(settings.paused),
      });
      return;
    }

    if (text.startsWith("/")) return;

    if (isWizardActive(chatId)) {
      handleWizardTextInput(chatId, text, msg.message_id).catch((e) => logError("wizardText", e));
      return;
    }

    const key = waitingForInput.get(chatId);
    if (!key) return;

    const settings = loadSettings(chatId);
    if (!settings) return;

    if (key === "checkIntervalMinutes" || key === "maxJobAgeDays") {
      waitingForInput.delete(chatId);
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num < 0 || (key === "checkIntervalMinutes" && num < 5)) {
        const hint = key === "checkIntervalMinutes" ? "Minimum is 5 minutes." : "Enter 0 or more.";
        bot.sendMessage(chatId, `Invalid number. ${hint}`);
        return;
      }
      settings[key] = num;
      saveSettings(settings);
      bot.sendMessage(chatId, `${LABELS[key]} saved.`);
      sendSettingsMenu(chatId, settings);
      if (key === "checkIntervalMinutes" && onSettingsChanged) onSettingsChanged();
    } else {
      const newItems = parseCommaSeparated(text);
      const merged = new Set([...settings[key], ...newItems]);
      settings[key] = [...merged];
      saveSettings(settings);
      sendArrayEditor(chatId, key as ArraySettingKey, settings);
    }
  });
}
