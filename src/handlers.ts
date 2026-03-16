import { Composer, GrammyError, InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import { createDefaultSettings, isOnboarded, UserSettings, loadSettings, saveSettings } from "./db";
import { getStoredJob, sendJob } from "./delivery";
import { formatSettings } from "./format";
import { logError } from "./logger";
import { ROLE_TECHS } from "./filter";
import { SENIORITY_LEVELS, JOB_TYPE_PRESETS, parseCommaSeparated } from "./utils";

type WizardStep = "welcome" | "roles" | "technologies" | "seniority" | "salary" | "locations";

interface WizardSession {
  step: WizardStep;
  messageId: number | null;
  chatId: string;
  createdAt: number;
  roles: Set<string>;
  technologies: Set<string>;
  seniority: Set<string>;
  minSalaryUsd: number;
  locations: Set<string>;
}

type ToggleField = "roles" | "technologies" | "seniority" | "locations";

const ROLE_PRESETS = [
  "Frontend",
  "Backend",
  "Fullstack",
  "DevOps",
  "Mobile",
  "Data & ML",
  "Design",
  "Product",
  "QA",
];

const WIZARD_TECH_PRESETS: Record<string, string[]> = {
  frontend: [
    "react", "vue", "angular", "typescript", "next.js", "svelte",
    "javascript", "tailwind", "redux", "graphql",
    "html", "css", "sass", "webpack", "vite",
  ],
  backend: [
    "node.js", "python", "go", "java", "rust", "ruby", "php",
    "postgresql", "mongodb", "redis", "elasticsearch",
    "django", "fastapi", "express", "spring", "laravel",
    "docker", "nginx", "rabbitmq", "kafka",
  ],
  devops: [
    "kubernetes", "terraform", "aws", "docker", "ci/cd", "linux",
    "ansible", "gcp", "azure", "nginx",
    "prometheus", "grafana", "jenkins", "helm",
  ],
  mobile: [
    "react native", "flutter", "swift", "kotlin",
    "typescript", "expo", "firebase",
  ],
  "data & ml": [
    "python", "tensorflow", "pytorch", "sql", "spark",
    "pandas", "scikit-learn", "jupyter", "postgresql",
    "airflow", "kafka", "docker",
  ],
  design: [
    "figma", "sketch", "adobe xd",
    "storybook", "css", "tailwind",
  ],
  product: [
    "jira", "analytics", "a/b testing",
    "sql", "amplitude", "mixpanel",
  ],
  qa: [
    "selenium", "cypress", "jest", "playwright",
    "pytest", "docker", "postman",
  ],
};

function getTechPresets(roles: Set<string>): string[] {
  const techs = new Set<string>();
  for (const role of roles) {
    const lower = role.toLowerCase();
    const keys = lower === "fullstack" ? ["frontend", "backend"] : [lower];
    for (const k of keys) for (const t of WIZARD_TECH_PRESETS[k] ?? []) techs.add(t);
  }
  return [...techs];
}

const SALARY_PRESETS = [
  { label: "Skip", value: 0 },
  { label: "$40k+", value: 40_000 },
  { label: "$60k+", value: 60_000 },
  { label: "$80k+", value: 80_000 },
  { label: "$100k+", value: 100_000 },
  { label: "$150k+", value: 150_000 },
  { label: "$200k+", value: 200_000 },
];

const LOCATION_PRESETS = ["anywhere", "europe", "usa", "uk", "canada", "asia"];
const WIZARD_SENIORITY = ["Junior", "Middle", "Senior", "Lead", "Staff"];

const STEP_FLOW: Record<string, WizardStep | "finish"> = {
  roles: "technologies",
  technologies: "seniority",
  seniority: "salary",
  salary: "locations",
  locations: "finish",
};

const WIZ_TOGGLE: Record<string, ToggleField> = {
  role: "roles",
  tech: "technologies",
  sen: "seniority",
  loc: "locations",
};

const wizardSessions = new Map<string, WizardSession>();
const WIZARD_TTL_MS = 30 * 60 * 1000;
const INPUT_TTL_MS = 10 * 60 * 1000;
const MAX_ARRAY_ITEMS = 50;
const MAX_ITEM_LENGTH = 100;

function sweepStale(): void {
  const now = Date.now();
  for (const [id, s] of wizardSessions) {
    if (now - s.createdAt > WIZARD_TTL_MS) wizardSessions.delete(id);
  }
  for (const [id, e] of waitingForInput) {
    if (now - e.createdAt > INPUT_TTL_MS) waitingForInput.delete(id);
  }
}

function toggleGrid(
  presets: string[],
  selected: Set<string>,
  prefix: string,
  perRow: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < presets.length; i += perRow) {
    for (const p of presets.slice(i, i + perRow))
      kb.text(selected.has(p) ? `\u2705 ${p}` : p, `wiz:${prefix}:${p}`);
    kb.row();
  }
  return kb;
}

function stepLabel(step: WizardStep): string {
  const labels: Record<string, string> = {
    roles: "Step 1 of 5 \u00b7 Roles",
    technologies: "Step 2 of 5 \u00b7 Technologies",
    seniority: "Step 3 of 5 \u00b7 Level",
    salary: "Step 4 of 5 \u00b7 Min Salary",
    locations: "Step 5 of 5 \u00b7 Locations",
  };
  return labels[step] ?? "";
}

function buildStepContent(session: WizardSession): { text: string; kb: InlineKeyboard } {
  const selected = (field: ToggleField) =>
    session[field].size > 0 ? `\n\nSelected: ${[...session[field]].join(", ")}` : "";

  if (session.step === "roles") {
    const text = `${stepLabel("roles")}\n\nWhat kind of role are you looking for?\nTap to select or type your own.${selected("roles")}`;
    const kb = toggleGrid(ROLE_PRESETS, session.roles, "role", 3);
    if (session.roles.size > 0) kb.text("Next \u2192", "wiz:done");
    return { text, kb };
  }

  if (session.step === "technologies") {
    const presets = getTechPresets(session.roles);
    const text = `${stepLabel("technologies")}\n\nWhat technologies do you work with?\nTap to select or type your own, comma-separated.${selected("technologies")}`;
    const kb = toggleGrid(presets, session.technologies, "tech", 3);
    kb.text("Skip \u2192", "wiz:skip");
    if (session.technologies.size > 0) kb.text("Next \u2192", "wiz:done");
    return { text, kb };
  }

  if (session.step === "seniority") {
    const text = `${stepLabel("seniority")}\n\nWhat's your experience level?\nTap to select. Empty = any level.${selected("seniority")}`;
    const kb = toggleGrid(WIZARD_SENIORITY, session.seniority, "sen", 3);
    kb.text("Skip \u2192", "wiz:skip");
    if (session.seniority.size > 0) kb.text("Next \u2192", "wiz:done");
    return { text, kb };
  }

  if (session.step === "salary") {
    const current = session.minSalaryUsd;
    const label = current > 0 ? `\n\nSelected: $${current / 1000}k+` : "";
    const text = `${stepLabel("salary")}\n\nMinimum annual salary (USD)?\nJobs without salary info will still show up.${label}`;
    const kb = new InlineKeyboard();
    for (let i = 0; i < SALARY_PRESETS.length; i += 3) {
      for (const p of SALARY_PRESETS.slice(i, i + 3))
        kb.text(current === p.value ? `\u2705 ${p.label}` : p.label, `wiz:sal:${p.value}`);
      kb.row();
    }
    kb.text("Skip \u2192", "wiz:skip");
    if (current > 0) kb.text("Next \u2192", "wiz:done");
    return { text, kb };
  }

  // locations
  const text = `${stepLabel("locations")}\n\nWhere do you want to work?\nTap to select or type your own. Skip = anywhere.${selected("locations")}`;
  const kb = toggleGrid(LOCATION_PRESETS, session.locations, "loc", 3);
  kb.text("Skip \u2192", "wiz:skip");
  if (session.locations.size > 0) kb.text("Next \u2192", "wiz:done");
  return { text, kb };
}

async function renderWizardStep(ctx: Context, session: WizardSession): Promise<void> {
  if (!session.messageId) return;
  const { text, kb } = buildStepContent(session);
  try {
    await ctx.api.editMessageText(session.chatId, session.messageId, text, { reply_markup: kb });
  } catch (e) {
    logError("Wizard render", e);
  }
}

async function finishWizard(ctx: Context, session: WizardSession): Promise<void> {
  const chatId = session.chatId;
  const s = loadSettings(chatId) ?? createDefaultSettings(chatId);
  s.roles = [...session.roles].slice(0, MAX_ARRAY_ITEMS);
  s.keywords = [...session.technologies].slice(0, MAX_ARRAY_ITEMS);
  s.seniority = [...session.seniority].slice(0, MAX_ARRAY_ITEMS);
  s.minSalaryUsd = session.minSalaryUsd;
  s.locations = [...session.locations].filter((l) => l !== "anywhere").slice(0, MAX_ARRAY_ITEMS);
  saveSettings(s);

  try {
    if (session.messageId) {
      await ctx.api.editMessageText(
        chatId,
        session.messageId,
        `All set! Here's your config:\n\n${formatSettings(s)}\n\nI'll notify you as new jobs appear.`,
      );
    }
  } catch (e) {
    logError("Wizard finish", e);
  }

  await ctx.api.sendMessage(
    chatId,
    "Tap the button below anytime to change your filters.\nTip: use /settings to add exclude keywords.",
    {
      reply_markup: replyKb(false),
    },
  );
  wizardSessions.delete(chatId);
  if (onWizardComplete) onWizardComplete(chatId);
}

type SettingKey =
  | "roles"
  | "keywords"
  | "excludeKeywords"
  | "locations"
  | "seniority"
  | "jobTypes"
  | "minSalaryUsd"
  | "checkIntervalMinutes"
  | "maxJobAgeDays";
type ArraySettingKey = "keywords" | "excludeKeywords" | "locations";

const LABELS: Record<SettingKey, string> = {
  roles: "Roles",
  keywords: "Technologies",
  excludeKeywords: "Exclude",
  locations: "Locations",
  seniority: "Seniority",
  jobTypes: "Job Type",
  minSalaryUsd: "Min Salary",
  checkIntervalMinutes: "Interval",
  maxJobAgeDays: "Max age",
};

const waitingForInput = new Map<
  string,
  { key: SettingKey; messageId: number; createdAt: number }
>();

function isArrayKey(key: string): key is ArraySettingKey {
  return key === "keywords" || key === "excludeKeywords" || key === "locations";
}

function replyKb(paused: boolean): Keyboard {
  return new Keyboard()
    .text("\u2699\ufe0f Settings")
    .text(paused ? "\u25b6 Resume" : "\u23f8 Pause")
    .resized();
}

function settingsKb(s: UserSettings): InlineKeyboard {
  return new InlineKeyboard()
    .text("Roles", "set:roles")
    .text("Technologies", "set:keywords")
    .row()
    .text("Exclude", "set:excludeKeywords")
    .text("Locations", "set:locations")
    .row()
    .text("Seniority", "set:seniority")
    .text("Job Type", "set:jobTypes")
    .row()
    .text("Min Salary", "set:minSalaryUsd")
    .text("Interval", "set:checkIntervalMinutes")
    .row()
    .text("Max age", "set:maxJobAgeDays")
    .row()
    .text(s.paused ? "\u25b6 Resume" : "\u23f8 Pause", "set:togglePause");
}

function arrayKb(key: ArraySettingKey, items: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < items.length; i += 2) {
    for (const item of items.slice(i, i + 2)) kb.text(`\u2715 ${item}`, `set:rm:${key}:${item}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

function senioritySettingsKb(selected: string[]): InlineKeyboard {
  const set = new Set(selected.map((s) => s.toLowerCase()));
  const kb = new InlineKeyboard();
  for (let i = 0; i < SENIORITY_LEVELS.length; i += 3) {
    for (const item of SENIORITY_LEVELS.slice(i, i + 3))
      kb.text(set.has(item.toLowerCase()) ? `\u2705 ${item}` : item, `set:sen:${item}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

function rolesSettingsKb(selected: string[]): InlineKeyboard {
  const set = new Set(selected);
  const kb = new InlineKeyboard();
  for (let i = 0; i < ROLE_PRESETS.length; i += 3) {
    for (const r of ROLE_PRESETS.slice(i, i + 3))
      kb.text(set.has(r) ? `\u2705 ${r}` : r, `set:role:${r}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

function salarySettingsKb(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const presets = [{ label: "No min", value: 0 }, ...SALARY_PRESETS.slice(1)];
  for (let i = 0; i < presets.length; i += 3) {
    for (const p of presets.slice(i, i + 3))
      kb.text(current === p.value ? `\u2705 ${p.label}` : p.label, `set:sal:${p.value}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

function jobTypeSettingsKb(selected: string[]): InlineKeyboard {
  const set = new Set(selected);
  const kb = new InlineKeyboard();
  for (let i = 0; i < JOB_TYPE_PRESETS.length; i += 3) {
    for (const item of JOB_TYPE_PRESETS.slice(i, i + 3))
      kb.text(set.has(item.toLowerCase()) ? `\u2705 ${item}` : item, `set:jtype:${item}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

async function editOrSend(
  ctx: Context,
  chatId: string,
  text: string,
  kb: InlineKeyboard,
  msgId?: number,
): Promise<void> {
  if (msgId !== undefined) {
    try {
      await ctx.api.editMessageText(chatId, msgId, text, { reply_markup: kb });
      return;
    } catch (err: unknown) {
      if (err instanceof GrammyError) {
        if (err.description.includes("message is not modified")) return;
        if (!err.description.includes("message to edit not found")) throw err;
      } else {
        throw err;
      }
    }
  }
  await ctx.api.sendMessage(chatId, text, { reply_markup: kb });
}

function showSettings(ctx: Context, chatId: string, s: UserSettings, msgId?: number): void {
  editOrSend(
    ctx,
    chatId,
    `\u2699\ufe0f Settings\n\n${formatSettings(s)}`,
    settingsKb(s),
    msgId,
  ).catch((e) => logError("showSettings", e));
}

function showArrayEditor(
  ctx: Context,
  chatId: string,
  key: ArraySettingKey,
  s: UserSettings,
  msgId?: number,
): void {
  const items = s[key];
  let text: string;
  if (items.length > 0) {
    text = `\u2699\ufe0f ${LABELS[key]}\n\n${items.join(", ")}\n\nTap to remove. Type to add more.`;
  } else if (key === "locations") {
    text = `\u2699\ufe0f ${LABELS[key]}\n\nAnywhere (no filter). Type to add locations.`;
  } else {
    text = `\u2699\ufe0f ${LABELS[key]}\n\nNothing here yet. Type to add, comma-separated.`;
  }
  editOrSend(ctx, chatId, text, arrayKb(key, items), msgId).catch((e) =>
    logError("showArrayEditor", e),
  );
}

function showToggleEditor(
  ctx: Context,
  chatId: string,
  label: string,
  selected: string[],
  kb: InlineKeyboard,
  msgId?: number,
): void {
  const lines = [`\u2699\ufe0f ${label}\n`];
  if (selected.length > 0) lines.push(`Selected: ${selected.join(", ")}\n`);
  lines.push("Tap to toggle.");
  editOrSend(ctx, chatId, lines.join("\n"), kb, msgId).catch((e) =>
    logError("showToggleEditor", e),
  );
}

function showSalaryEditor(ctx: Context, chatId: string, s: UserSettings, msgId?: number): void {
  const label = s.minSalaryUsd > 0 ? `$${s.minSalaryUsd / 1000}k+` : "any";
  const text = `\u2699\ufe0f Min Salary\n\nCurrently: ${label}\nJobs without salary info will still show up.`;
  editOrSend(ctx, chatId, text, salarySettingsKb(s.minSalaryUsd), msgId).catch((e) =>
    logError("showSalaryEditor", e),
  );
}

let onWizardComplete: ((chatId: string) => void) | null = null;
let onIntervalChanged: (() => void) | null = null;

export function setOnWizardComplete(cb: (chatId: string) => void): void {
  onWizardComplete = cb;
}
export function setOnIntervalChanged(cb: () => void): void {
  onIntervalChanged = cb;
}

export const handlers = new Composer<Context>();

handlers.command("start", async (ctx) => {
  sweepStale();
  const chatId = String(ctx.chat.id);
  if (wizardSessions.has(chatId)) return;

  const s = loadSettings(chatId);
  if (s && isOnboarded(s)) {
    await ctx.reply("You're already set up. Use /settings to make changes.", {
      reply_markup: replyKb(s.paused),
    });
    return;
  }

  const msg = await ctx.reply(
    "Hey! I'm Ahead \u2014 I scan remote job boards and send you matches.\n\n" +
      "Let's pick your preferences. Takes about 30 seconds,\nand you can always change them later.",
    { reply_markup: new InlineKeyboard().text("Let's go \u2192", "wiz:start") },
  );
  wizardSessions.set(chatId, {
    step: "welcome",
    messageId: msg.message_id,
    chatId,
    createdAt: Date.now(),
    roles: new Set(),
    technologies: new Set(),
    seniority: new Set(),
    minSalaryUsd: 0,
    locations: new Set(),
  });
});

handlers.command("settings", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const s = loadSettings(chatId);
  if (!s || !isOnboarded(s)) {
    await ctx.reply("Run /start first to set up your preferences.");
    return;
  }
  showSettings(ctx, chatId, s);
});

handlers.command("cancel", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (wizardSessions.has(chatId)) {
    wizardSessions.delete(chatId);
    await ctx.reply("Cancelled. Send /start to try again.");
    return;
  }
  waitingForInput.delete(chatId);
  const s = loadSettings(chatId);
  if (s) showSettings(ctx, chatId, s);
  else await ctx.reply("Cancelled.");
});

handlers.hears("\u2699\ufe0f Settings", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const s = loadSettings(chatId);
  if (s && isOnboarded(s)) showSettings(ctx, chatId, s);
  else await ctx.reply("Run /start first to set up your preferences.");
});

handlers.hears(/^(\u23f8 Pause|\u25b6 Resume)$/, async (ctx) => {
  const chatId = String(ctx.chat.id);
  const s = loadSettings(chatId);
  if (!s) return;
  s.paused = !s.paused;
  saveSettings(s);
  await ctx.reply(
    s.paused
      ? "Paused. You won't get new jobs until you resume."
      : "Resumed! You'll get new jobs again.",
    { reply_markup: replyKb(s.paused) },
  );
});

handlers.callbackQuery(/^wiz:/, async (ctx) => {
  const session = wizardSessions.get(String(ctx.chat!.id));
  if (!session) return;
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery.data;

  if (data === "wiz:start") {
    session.step = "roles";
    await renderWizardStep(ctx, session);
    return;
  }

  if (data === "wiz:done" || data === "wiz:skip") {
    const next = STEP_FLOW[session.step];
    if (!next || next === "finish") await finishWizard(ctx, session);
    else {
      session.step = next;
      await renderWizardStep(ctx, session);
    }
    return;
  }

  const salMatch = data.match(/^wiz:sal:(\d+)$/);
  if (salMatch) {
    session.minSalaryUsd = parseInt(salMatch[1]!, 10);
    await renderWizardStep(ctx, session);
    return;
  }

  const toggleMatch = data.match(/^wiz:(role|tech|sen|loc):(.+)$/);
  if (toggleMatch) {
    const field = WIZ_TOGGLE[toggleMatch[1]!]!;
    const value = toggleMatch[2]!;
    const set = session[field];

    if (field === "locations") {
      if (value === "anywhere") {
        session.locations.clear();
        session.locations.add("anywhere");
      } else {
        session.locations.delete("anywhere");
        if (set.has(value)) set.delete(value);
        else set.add(value);
      }
    } else {
      if (set.has(value)) set.delete(value);
      else set.add(value);
    }

    await renderWizardStep(ctx, session);
  }
});

handlers.callbackQuery(/^set:/, async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = String(ctx.chat!.id);
  const msgId = ctx.callbackQuery.message?.message_id;

  if (data === "set:togglePause") {
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    s.paused = !s.paused;
    saveSettings(s);
    await ctx.answerCallbackQuery(s.paused ? "Paused." : "Resumed!");
    showSettings(ctx, chatId, s, msgId);
    return;
  }

  if (data === "set:back") {
    const pending = waitingForInput.get(chatId);
    waitingForInput.delete(chatId);
    const s = loadSettings(chatId);
    if (!s) return;
    await ctx.answerCallbackQuery(pending ? `${LABELS[pending.key]} saved.` : undefined);
    showSettings(ctx, chatId, s, msgId);
    return;
  }

  if (data.startsWith("set:role:")) {
    const role = data.slice(9);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    const idx = s.roles.indexOf(role);
    if (idx >= 0) s.roles.splice(idx, 1);
    else s.roles.push(role);
    saveSettings(s);
    await ctx.answerCallbackQuery();
    showToggleEditor(ctx, chatId, "Roles", s.roles, rolesSettingsKb(s.roles), msgId);
    return;
  }

  if (data.startsWith("set:sen:")) {
    const level = data.slice(8);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    const idx = s.seniority.findIndex((x) => x.toLowerCase() === level.toLowerCase());
    if (idx >= 0) s.seniority.splice(idx, 1);
    else s.seniority.push(level);
    saveSettings(s);
    await ctx.answerCallbackQuery();
    showToggleEditor(ctx, chatId, "Seniority", s.seniority, senioritySettingsKb(s.seniority), msgId);
    return;
  }

  if (data.startsWith("set:jtype:")) {
    const type = data.slice(10).toLowerCase();
    const s = loadSettings(chatId);
    if (!s) { await ctx.answerCallbackQuery("Run /start first."); return; }
    const idx = s.jobTypes.indexOf(type);
    if (idx >= 0) s.jobTypes.splice(idx, 1);
    else s.jobTypes.push(type);
    saveSettings(s);
    await ctx.answerCallbackQuery();
    showToggleEditor(ctx, chatId, "Job Type", s.jobTypes, jobTypeSettingsKb(s.jobTypes), msgId);
    return;
  }

  if (data.startsWith("set:sal:")) {
    const value = parseInt(data.slice(8), 10);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    s.minSalaryUsd = value;
    saveSettings(s);
    await ctx.answerCallbackQuery();
    showSalaryEditor(ctx, chatId, s, msgId);
    return;
  }

  if (data.startsWith("set:rm:")) {
    const parts = data.slice(7).split(":");
    const key = parts[0] ?? "";
    if (!isArrayKey(key)) return;
    const value = parts.slice(1).join(":");
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    s[key] = s[key].filter((item) => item !== value);
    saveSettings(s);
    await ctx.answerCallbackQuery(`Removed "${value}"`);
    showArrayEditor(ctx, chatId, key, s, msgId);
    return;
  }

  const raw = data.slice(4);
  if (!(raw in LABELS)) return;
  const key = raw as SettingKey;
  const s = loadSettings(chatId);
  if (!s) {
    await ctx.answerCallbackQuery("Run /start first.");
    return;
  }
  await ctx.answerCallbackQuery();

  if (key === "roles") {
    showToggleEditor(ctx, chatId, "Roles", s.roles, rolesSettingsKb(s.roles), msgId);
    return;
  }
  if (key === "seniority") {
    showToggleEditor(
      ctx,
      chatId,
      "Seniority",
      s.seniority,
      senioritySettingsKb(s.seniority),
      msgId,
    );
    return;
  }
  if (key === "jobTypes") {
    showToggleEditor(ctx, chatId, "Job Type", s.jobTypes, jobTypeSettingsKb(s.jobTypes), msgId);
    return;
  }
  if (key === "minSalaryUsd") {
    showSalaryEditor(ctx, chatId, s, msgId);
    return;
  }

  if (isArrayKey(key)) {
    waitingForInput.set(chatId, { key, messageId: msgId!, createdAt: Date.now() });
    showArrayEditor(ctx, chatId, key, s, msgId);
    return;
  }

  waitingForInput.set(chatId, { key, messageId: msgId!, createdAt: Date.now() });
  const numKey = key as "checkIntervalMinutes" | "maxJobAgeDays";
  const text =
    numKey === "checkIntervalMinutes"
      ? `\u2699\ufe0f Interval\n\nCurrently checking every ${s[numKey]} minutes.\nType a new number.`
      : `\u2699\ufe0f Max age\n\nCurrently ${s[numKey]} days.\nType a new number, or 0 for no limit.`;
  editOrSend(ctx, chatId, text, new InlineKeyboard().text("\u2190 Back", "set:back"), msgId).catch(
    (e) => logError("showNumericEditor", e),
  );
});

handlers.callbackQuery(/^job:(.+)$/, async (ctx) => {
  const stored = getStoredJob(ctx.match[1]!);
  if (!stored) {
    await ctx.answerCallbackQuery("This job listing has expired.");
    return;
  }
  await ctx.answerCallbackQuery();
  await sendJob(String(ctx.chat!.id), stored.job, stored.parsed);
});

handlers.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const session = wizardSessions.get(chatId);
  if (session) {
    if (session.step !== "roles" && session.step !== "technologies" && session.step !== "locations")
      return;
    const field: ToggleField = session.step;
    const items = parseCommaSeparated(text).filter((i) => i.length <= MAX_ITEM_LENGTH);
    if (items.length === 0) return;
    const set = session[field];
    for (const item of items) {
      if (set.size >= MAX_ARRAY_ITEMS) break;
      set.add(item);
    }
    await ctx.deleteMessage().catch(() => {});
    await renderWizardStep(ctx, session);
    return;
  }

  const pending = waitingForInput.get(chatId);
  if (!pending) return;
  const s = loadSettings(chatId);
  if (!s) return;
  ctx.deleteMessage().catch(() => {});

  if (pending.key === "checkIntervalMinutes" || pending.key === "maxJobAgeDays") {
    waitingForInput.delete(chatId);
    const num = parseInt(text.trim(), 10);
    if (isNaN(num) || num < 0 || (pending.key === "checkIntervalMinutes" && num < 5)) {
      await ctx.reply(
        `Invalid number. ${pending.key === "checkIntervalMinutes" ? "Minimum is 5 minutes." : "Enter 0 or more."}`,
      );
      return;
    }
    s[pending.key] = num;
    saveSettings(s);
    showSettings(ctx, chatId, s, pending.messageId);
    if (pending.key === "checkIntervalMinutes" && onIntervalChanged) onIntervalChanged();
  } else if (isArrayKey(pending.key)) {
    const newItems = parseCommaSeparated(text).filter((i) => i.length <= MAX_ITEM_LENGTH);
    const merged = new Set([...s[pending.key], ...newItems]);
    s[pending.key] = [...merged].slice(0, MAX_ARRAY_ITEMS);
    saveSettings(s);
    showArrayEditor(ctx, chatId, pending.key, s, pending.messageId);
  }
});
