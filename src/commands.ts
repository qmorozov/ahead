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
import { SENIORITY_LEVELS } from "./utils";

type SettingKey =
  | "keywords"
  | "excludeKeywords"
  | "locations"
  | "seniority"
  | "checkIntervalMinutes"
  | "maxJobAgeDays";
type ArraySettingKey = "keywords" | "excludeKeywords" | "locations";

const waitingForInput = new Map<string, { key: SettingKey; messageId: number }>();

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
        { text: "Seniority", callback_data: "set:seniority" },
      ],
      [
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
  seniority: "Seniority",
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

function buildSeniorityKeyboard(
  selected: string[],
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const set = new Set(selected.map((s) => s.toLowerCase()));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < SENIORITY_LEVELS.length; i += 3) {
    const row = SENIORITY_LEVELS.slice(i, i + 3).map((item) => ({
      text: set.has(item.toLowerCase()) ? `✅ ${item}` : item,
      callback_data: `set:sen:${item}`,
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

async function editOrSend(
  chatId: string,
  text: string,
  markup: ReturnType<typeof buildSettingsKeyboard>,
  messageId?: number,
): Promise<void> {
  if (messageId !== undefined) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: markup,
      });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("message is not modified")) return;
      if (!msg.includes("message to edit not found")) throw err;
    }
  }
  await bot.sendMessage(chatId, text, { reply_markup: markup });
}

function showSettingsMenu(chatId: string, settings: UserSettings, msgId?: number): void {
  editOrSend(chatId, settingsText(settings), buildSettingsKeyboard(settings), msgId)
    .catch((e) => logError("showSettingsMenu", e));
}

function showArrayEditor(chatId: string, key: ArraySettingKey, settings: UserSettings, msgId?: number): void {
  editOrSend(chatId, arrayEditorText(key, settings), buildArrayEditKeyboard(key, settings[key]), msgId)
    .catch((e) => logError("showArrayEditor", e));
}

function showSeniorityEditor(chatId: string, settings: UserSettings, msgId?: number): void {
  editOrSend(chatId, seniorityText(settings), buildSeniorityKeyboard(settings.seniority), msgId)
    .catch((e) => logError("showSeniorityEditor", e));
}

function settingsText(settings: UserSettings): string {
  return `⚙️ Settings\n\n${formatSettings(settings)}`;
}

function seniorityText(settings: UserSettings): string {
  const selected = settings.seniority;
  const lines = [`⚙️ Seniority\n`];
  if (selected.length > 0) {
    lines.push(`Selected: ${selected.join(", ")}\n`);
  }
  lines.push("Tap to toggle. Empty = any level.");
  return lines.join("\n");
}

function arrayEditorText(key: ArraySettingKey, settings: UserSettings): string {
  const items = settings[key];
  const label = LABELS[key];
  const lines = [`⚙️ ${label}\n`];
  if (items.length > 0) {
    lines.push(`${items.join(", ")}\n`);
    lines.push("Tap to remove. Type to add more.");
  } else {
    lines.push("Nothing here yet. Type to add, comma-separated.");
  }
  return lines.join("\n");
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

function tryDelete(chatId: string, messageId: number): void {
  bot.deleteMessage(chatId, messageId).catch(() => {});
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

    showSettingsMenu(chatId, settings);
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
      showSettingsMenu(chatId, settings);
    } else {
      bot.sendMessage(chatId, "Cancelled.");
    }
  });

  bot.on("callback_query", (query) => {
    if (!query.data || !query.message) return;

    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;

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
      showSettingsMenu(chatId, settings, msgId);
      return;
    }

    if (query.data === "set:back") {
      const pending = waitingForInput.get(chatId);
      waitingForInput.delete(chatId);
      const settings = loadSettings(chatId);
      if (settings) {
        if (pending) {
          bot.answerCallbackQuery(query.id, { text: `${LABELS[pending.key]} saved.` });
        } else {
          bot.answerCallbackQuery(query.id);
        }
        showSettingsMenu(chatId, settings, msgId);
      }
      return;
    }

    if (query.data.startsWith("set:sen:")) {
      const level = query.data.replace("set:sen:", "");
      const settings = loadSettings(chatId);
      if (!settings) {
        bot.answerCallbackQuery(query.id, { text: "Run /start first." });
        return;
      }

      const lower = level.toLowerCase();
      const idx = settings.seniority.findIndex((s) => s.toLowerCase() === lower);
      if (idx >= 0) {
        settings.seniority.splice(idx, 1);
      } else {
        settings.seniority.push(level);
      }
      saveSettings(settings);
      bot.answerCallbackQuery(query.id);
      showSeniorityEditor(chatId, settings, msgId);
      return;
    }

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
      showArrayEditor(chatId, key, settings, msgId);
      return;
    }

    if (query.data.startsWith("set:")) {
      const key = query.data.replace("set:", "") as SettingKey;
      const settings = loadSettings(chatId);

      if (!settings) {
        bot.answerCallbackQuery(query.id, { text: "Run /start first." });
        return;
      }

      bot.answerCallbackQuery(query.id);

      if (key === "seniority") {
        showSeniorityEditor(chatId, settings, msgId);
        return;
      }

      if (key === "keywords" || key === "excludeKeywords" || key === "locations") {
        waitingForInput.set(chatId, { key, messageId: msgId });
        showArrayEditor(chatId, key, settings, msgId);
        return;
      }

      waitingForInput.set(chatId, { key, messageId: msgId });
      const current = settings[key];
      const prompt =
        key === "checkIntervalMinutes"
          ? `⚙️ Interval\n\nCurrently checking every ${current} minutes.\nType a new number.`
          : `⚙️ Max age\n\nCurrently ${current} days.\nType a new number, or 0 for no limit.`;

      editOrSend(chatId, prompt, {
        inline_keyboard: [[{ text: "← Back", callback_data: "set:back" }]],
      }, msgId).catch((e) => logError("showNumericEditor", e));
    }
  });

  bot.on("message", (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;

    if (!text) return;

    if (text === "⚙️ Settings") {
      const settings = loadSettings(chatId);
      if (settings && isOnboarded(settings)) {
        showSettingsMenu(chatId, settings);
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

    const pending = waitingForInput.get(chatId);
    if (!pending) return;

    const settings = loadSettings(chatId);
    if (!settings) return;

    tryDelete(chatId, msg.message_id);

    if (pending.key === "checkIntervalMinutes" || pending.key === "maxJobAgeDays") {
      waitingForInput.delete(chatId);
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num < 0 || (pending.key === "checkIntervalMinutes" && num < 5)) {
        const hint = pending.key === "checkIntervalMinutes" ? "Minimum is 5 minutes." : "Enter 0 or more.";
        bot.sendMessage(chatId, `Invalid number. ${hint}`);
        return;
      }
      settings[pending.key] = num;
      saveSettings(settings);
      showSettingsMenu(chatId, settings, pending.messageId);
      if (pending.key === "checkIntervalMinutes" && onSettingsChanged) onSettingsChanged();
    } else {
      const newItems = parseCommaSeparated(text);
      const merged = new Set([...settings[pending.key], ...newItems]);
      settings[pending.key] = [...merged];
      saveSettings(settings);
      showArrayEditor(chatId, pending.key as ArraySettingKey, settings, pending.messageId);
    }
  });
}
