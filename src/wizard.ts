import { bot } from "./bot";
import {
  createDefaultSettings,
  formatSettings,
  parseCommaSeparated,
  loadSettings,
  saveSettings,
  saveWizardSession,
  loadAllWizardSessions,
  deleteWizardSession,
} from "./db";
import { log, logError } from "./logger";

type WizardStep = "welcome" | "keywords" | "excludeKeywords" | "locations";
type DataStep = Exclude<WizardStep, "welcome">;

interface WizardSession {
  step: WizardStep;
  messageId: number | null;
  chatId: string;
  keywords: Set<string>;
  excludeKeywords: Set<string>;
  locations: Set<string>;
}

interface StepConfig {
  label: string;
  question: string;
  presets: string[];
  prefix: string;
  placeholder: string;
  field: DataStep;
  next: WizardStep | "finish";
}

const KEYWORD_PRESETS = [
  "react",
  "typescript",
  "node.js",
  "python",
  "vue",
  "next.js",
  "go",
  "rust",
  "devops",
  "java",
  "ruby",
  "php",
];
const EXCLUDE_PRESETS = ["php", "java", "wordpress", ".net", "ruby", "angular"];
const LOCATION_PRESETS = ["worldwide", "europe", "usa", "emea", "asia", "uk"];

const STEPS: Record<DataStep, StepConfig> = {
  keywords: {
    label: "Keywords",
    question: "What kind of jobs are you looking for?",
    presets: KEYWORD_PRESETS,
    prefix: "kw",
    placeholder: "e.g. react, frontend, product manager",
    field: "keywords",
    next: "excludeKeywords",
  },
  excludeKeywords: {
    label: "Exclude",
    question: "Any keywords that should disqualify a job?",
    presets: EXCLUDE_PRESETS,
    prefix: "ex",
    placeholder: "e.g. intern, unpaid, senior",
    field: "excludeKeywords",
    next: "locations",
  },
  locations: {
    label: "Locations",
    question: "Where do you want to work?",
    presets: LOCATION_PRESETS,
    prefix: "loc",
    placeholder: "e.g. berlin, remote, canada",
    field: "locations",
    next: "finish",
  },
};

const STEP_NUMBER: Record<DataStep, number> = {
  keywords: 1,
  excludeKeywords: 2,
  locations: 3,
};

const sessions = new Map<string, WizardSession>();

let onCompleteCallback: ((chatId: string) => void) | null = null;

export function setOnWizardComplete(cb: (chatId: string) => void): void {
  onCompleteCallback = cb;
}

export function isWizardActive(chatId: string): boolean {
  return sessions.has(chatId);
}

export function cancelWizard(chatId: string): void {
  sessions.delete(chatId);
  deleteWizardSession(chatId);
}

function persistSession(session: WizardSession): void {
  saveWizardSession({
    chatId: session.chatId,
    step: session.step,
    messageId: session.messageId,
    keywords: [...session.keywords],
    excludeKeywords: [...session.excludeKeywords],
    locations: [...session.locations],
  });
}

export function restoreWizardSessions(): void {
  const rows = loadAllWizardSessions();
  for (const row of rows) {
    sessions.set(row.chatId, {
      chatId: row.chatId,
      step: row.step as WizardStep,
      messageId: row.messageId,
      keywords: new Set(row.keywords),
      excludeKeywords: new Set(row.excludeKeywords),
      locations: new Set(row.locations),
    });
  }
  if (rows.length > 0) {
    log(`Restored ${rows.length} wizard session(s).`);
  }
}

function getStepConfig(step: WizardStep): StepConfig | null {
  return step === "welcome" ? null : STEPS[step];
}

function buildToggleKeyboard(
  cfg: StepConfig,
  selected: Set<string>,
  step: WizardStep,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < cfg.presets.length; i += 3) {
    const row = cfg.presets.slice(i, i + 3).map((item) => ({
      text: selected.has(item) ? `✅ ${item}` : item,
      callback_data: `wiz:${cfg.prefix}:${item}`,
    }));
    rows.push(row);
  }

  const bottomRow: Array<{ text: string; callback_data: string }> = [];

  if (step !== "keywords") {
    bottomRow.push({ text: "Skip →", callback_data: "wiz:skip" });
  }
  if (selected.size > 0) {
    bottomRow.push({ text: "Next →", callback_data: "wiz:done" });
  }

  if (bottomRow.length > 0) rows.push(bottomRow);

  return { inline_keyboard: rows };
}

function getStepText(session: WizardSession): string {
  const cfg = getStepConfig(session.step);
  if (!cfg) return "";

  const step = STEP_NUMBER[cfg.field];
  const selected = session[cfg.field];

  const lines = [
    `Step ${step} of 3 · ${cfg.label}\n`,
    cfg.question,
    "Tap to select or type your own, comma-separated.",
  ];
  if (selected.size > 0) {
    lines.push("", `Selected: ${[...selected].join(", ")}`);
  }
  return lines.join("\n");
}

function getStepKeyboard(session: WizardSession) {
  const cfg = getStepConfig(session.step);
  if (!cfg) return undefined;
  return buildToggleKeyboard(cfg, session[cfg.field], session.step);
}

async function renderStep(session: WizardSession): Promise<void> {
  const text = getStepText(session);
  const cfg = getStepConfig(session.step);

  persistSession(session);

  try {
    if (session.messageId) {
      const keyboard = getStepKeyboard(session);
      await bot.editMessageText(text, {
        chat_id: session.chatId,
        message_id: session.messageId,
        reply_markup: keyboard
          ? ({
              ...keyboard,
              input_field_placeholder: cfg?.placeholder,
            } as typeof keyboard)
          : undefined,
      });
    }
  } catch (error) {
    logError("Wizard render", error);
  }
}

async function finishWizard(session: WizardSession): Promise<void> {
  const chatId = session.chatId;
  let settings = loadSettings(chatId);

  if (!settings) {
    settings = createDefaultSettings(chatId);
  }

  settings.keywords = [...session.keywords];
  settings.excludeKeywords = [...session.excludeKeywords];
  settings.locations = [...session.locations];
  saveSettings(settings);

  const summary = [
    "All set! Here's your config:\n",
    formatSettings(settings),
    "\nI'll notify you as new jobs appear.",
  ].join("\n");

  try {
    if (session.messageId) {
      await bot.editMessageText(summary, {
        chat_id: chatId,
        message_id: session.messageId,
      });
    }
  } catch (error) {
    logError("Wizard finish", error);
  }

  await bot.sendMessage(chatId, "Tap the button below anytime to change your filters.", {
    reply_markup: {
      keyboard: [[{ text: "⚙️ Settings" }, { text: "⏸ Pause" }]],
      resize_keyboard: true,
    },
  });

  sessions.delete(chatId);
  deleteWizardSession(chatId);

  if (onCompleteCallback) onCompleteCallback(chatId);
}

function advanceStep(session: WizardSession): "render" | "finish" {
  const cfg = getStepConfig(session.step);
  if (!cfg || cfg.next === "finish") return "finish";
  session.step = cfg.next;
  return "render";
}

export async function startWizard(chatId: string): Promise<void> {
  const welcome = [
    "Hey! I'm Ahead — I scan remote job boards and send you matches.\n",
    "Let's pick your preferences. Takes about 30 seconds,",
    "and you can always change them later.",
  ].join("\n");

  const msg = await bot.sendMessage(chatId, welcome, {
    reply_markup: {
      inline_keyboard: [[{ text: "Let's go →", callback_data: "wiz:start" }]],
    },
  });

  const session: WizardSession = {
    step: "welcome",
    messageId: msg.message_id,
    chatId,
    keywords: new Set(),
    excludeKeywords: new Set(),
    locations: new Set(),
  };

  sessions.set(chatId, session);
  persistSession(session);
}

export async function handleWizardCallback(
  chatId: string,
  data: string,
  queryId: string,
): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) return;

  await bot.answerCallbackQuery(queryId);

  if (data === "wiz:start") {
    session.step = "keywords";
    await renderStep(session);
    return;
  }

  if (data === "wiz:done" || data === "wiz:skip") {
    const action = advanceStep(session);
    if (action === "finish") {
      await finishWizard(session);
    } else {
      await renderStep(session);
    }
    return;
  }

  for (const cfg of Object.values(STEPS)) {
    const prefix = `wiz:${cfg.prefix}:`;
    if (data.startsWith(prefix)) {
      const item = data.slice(prefix.length);
      const set = session[cfg.field];
      if (set.has(item)) set.delete(item);
      else set.add(item);
      await renderStep(session);
      return;
    }
  }
}

export async function handleWizardTextInput(
  chatId: string,
  text: string,
  messageId: number,
): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) return;

  const cfg = getStepConfig(session.step);
  if (!cfg) return;

  const items = parseCommaSeparated(text);

  if (items.length === 0) return;

  for (const item of items) {
    session[cfg.field].add(item);
  }

  try {
    await bot.deleteMessage(chatId, messageId);
  } catch {}

  await renderStep(session);
}
