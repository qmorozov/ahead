import { Composer, GrammyError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { UserSettings, loadSettings, saveSettings } from "../db";
import { formatSettings } from "./format";
import { logError } from "../lib/logger";
import { WIZARD, POLLING } from "../constants";
import {
  ROLE_PRESETS,
  WIZARD_SENIORITY,
  WORK_FORMAT_PRESETS,
  REMOTE_LOCATION_PRESETS,
  LOCATION_SETTINGS_PRESETS,
  LANGUAGE_PRESETS,
  EXCLUDE_PRESETS,
  ALL_SOURCE_NAMES,
  JOB_TYPE_PRESETS,
  getSalaryPresets,
  isRemoteOnly,
} from "./presets";
import { toggleGrid, toRows } from "./keyboards";

type SettingKey =
  | "roles"
  | "keywords"
  | "excludeKeywords"
  | "locations"
  | "seniority"
  | "jobTypes"
  | "workArrangement"
  | "acceptedLanguages"
  | "enabledSources"
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
  workArrangement: "Work Format",
  acceptedLanguages: "Languages",
  enabledSources: "Sources",
  minSalaryUsd: "Min Salary",
  checkIntervalMinutes: "Interval",
  maxJobAgeDays: "Max age",
};

export const waitingForInput = new Map<
  string,
  { key: SettingKey; messageId: number; createdAt: number }
>();

let onIntervalChanged: (() => void) | null = null;

export function setOnIntervalChanged(cb: () => void): void {
  onIntervalChanged = cb;
}

export function fireIntervalChanged(): void {
  if (onIntervalChanged) onIntervalChanged();
}

export function sweepStaleInputs(): void {
  const now = Date.now();
  for (const [id, e] of waitingForInput) {
    if (now - e.createdAt > WIZARD.INPUT_TTL_MS) waitingForInput.delete(id);
  }
}

export function isArrayKey(key: string): key is ArraySettingKey {
  return key === "keywords" || key === "excludeKeywords" || key === "locations";
}

async function loadSettingsOrReject(ctx: Context, chatId: string): Promise<UserSettings | null> {
  const s = loadSettings(chatId);
  if (!s) await ctx.answerCallbackQuery("Run /start first.");
  return s;
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
    .text("Work Format", "set:workArrangement")
    .text("Languages", "set:acceptedLanguages")
    .row()
    .text("Sources", "set:enabledSources")
    .text("Min Salary", "set:minSalaryUsd")
    .row()
    .text("Interval", "set:checkIntervalMinutes")
    .text("Max age", "set:maxJobAgeDays")
    .row()
    .text(s.paused ? "\u25b6 Resume" : "\u23f8 Pause", "set:togglePause");
}

function arrayKb(key: ArraySettingKey, items: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of toRows(items, 2)) {
    for (const item of row) kb.text(`\u2715 ${item}`, `set:rm:${key}:${item}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

export function toggleSettingsKb(
  presets: string[],
  selected: string[],
  prefix: string,
  caseSensitive = true,
): InlineKeyboard {
  const kb = toggleGrid(presets, selected, `set:${prefix}`, 3, caseSensitive);
  return kb.text("\u2190 Back", "set:back");
}

function salarySettingsKb(current: number, locations: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const regionPresets = getSalaryPresets(locations);
  const hasSkip = regionPresets[0]?.value === 0;
  const presets = [
    { label: "No min", value: 0 },
    ...(hasSkip ? regionPresets.slice(1) : regionPresets),
  ];
  for (const row of toRows(presets, 3)) {
    for (const p of row)
      kb.text(current === p.value ? `\u2705 ${p.label}` : p.label, `set:sal:${p.value}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

function workFormatKb(selected: string[]): InlineKeyboard {
  const kb = toggleGrid(WORK_FORMAT_PRESETS, selected, "set:wf", 1);
  return kb.text("\u2190 Back", "set:back");
}

function sourcesKb(enabled: string[]): InlineKeyboard {
  const kb = toggleGrid(ALL_SOURCE_NAMES, enabled, "set:src", 2);
  return kb.text("\u2190 Back", "set:back");
}

function intervalKb(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const v of [15, 30, 60])
    kb.text(current === v ? `\u2705 ${v} min` : `${v} min`, `set:intv:${v}`);
  kb.row();
  for (const v of [120, 360])
    kb.text(current === v ? `\u2705 ${v} min` : `${v} min`, `set:intv:${v}`);
  kb.row().text("\u2190 Back", "set:back");
  return kb;
}

function ageKb(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const v of [1, 2, 3]) kb.text(current === v ? `\u2705 ${v}d` : `${v}d`, `set:age:${v}`);
  kb.row();
  const noLim = current === 0 ? "\u2705 No limit" : "No limit";
  kb.text(current === 7 ? `\u2705 7d` : "7d", `set:age:7`).text(noLim, `set:age:0`);
  kb.row().text("\u2190 Back", "set:back");
  return kb;
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

export function showSettings(ctx: Context, chatId: string, s: UserSettings, msgId?: number): void {
  editOrSend(
    ctx,
    chatId,
    `\u2699\ufe0f Settings\n\n${formatSettings(s)}`,
    settingsKb(s),
    msgId,
  ).catch((e) => logError("showSettings", e));
}

export function showArrayEditor(
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

export function showToggleEditor(
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
  editOrSend(ctx, chatId, text, salarySettingsKb(s.minSalaryUsd, s.locations), msgId).catch((e) =>
    logError("showSalaryEditor", e),
  );
}

function showWorkFormatEditor(ctx: Context, chatId: string, s: UserSettings, msgId?: number): void {
  const sel = s.workArrangement.length > 0 ? s.workArrangement.join(", ") : "any";
  editOrSend(
    ctx,
    chatId,
    `\u2699\ufe0f Work Format\n\nSelected: ${sel}\nTap to toggle.`,
    workFormatKb(s.workArrangement),
    msgId,
  ).catch((e) => logError("showWfEditor", e));
}

function showSourcesEditor(ctx: Context, chatId: string, s: UserSettings, msgId?: number): void {
  const enabled = s.enabledSources.length > 0 ? s.enabledSources : ALL_SOURCE_NAMES;
  const count = enabled.length;
  editOrSend(
    ctx,
    chatId,
    `\u2699\ufe0f Sources (${count} of ${ALL_SOURCE_NAMES.length} active)\n\nTap to toggle.`,
    sourcesKb(enabled),
    msgId,
  ).catch((e) => logError("showSrcEditor", e));
}

function showIntervalEditor(ctx: Context, chatId: string, value: number, msgId?: number): void {
  editOrSend(
    ctx,
    chatId,
    `\u2699\ufe0f Interval\n\nCurrently: every ${value} minutes.\nTap or type a number.`,
    intervalKb(value),
    msgId,
  ).catch((e) => logError("showIntervalEditor", e));
}

function showAgeEditor(ctx: Context, chatId: string, value: number, msgId?: number): void {
  editOrSend(
    ctx,
    chatId,
    `\u2699\ufe0f Max age\n\nCurrently: ${value > 0 ? `${value} days` : "no limit"}.\nTap or type a number.`,
    ageKb(value),
    msgId,
  ).catch((e) => logError("showAgeEditor", e));
}

interface CallbackRoute {
  prefix: string;
  handle(
    value: string,
    s: UserSettings,
    ctx: Context,
    chatId: string,
    msgId: number | undefined,
  ): string | void;
}

interface ToggleRouteConfig {
  prefix: string;
  field: keyof Pick<UserSettings, "roles" | "seniority" | "jobTypes" | "excludeKeywords">;
  label: string;
  presets: string[];
  caseSensitive: boolean;
}

const TOGGLE_ROUTES: readonly ToggleRouteConfig[] = [
  {
    prefix: "set:role:",
    field: "roles",
    label: "Roles",
    presets: ROLE_PRESETS,
    caseSensitive: true,
  },
  {
    prefix: "set:sen:",
    field: "seniority",
    label: "Seniority",
    presets: WIZARD_SENIORITY,
    caseSensitive: false,
  },
  {
    prefix: "set:jtype:",
    field: "jobTypes",
    label: "Job Type",
    presets: JOB_TYPE_PRESETS,
    caseSensitive: false,
  },
  {
    prefix: "set:excl:",
    field: "excludeKeywords",
    label: "Exclude",
    presets: EXCLUDE_PRESETS,
    caseSensitive: false,
  },
];

function buildToggleRoute(cfg: ToggleRouteConfig): CallbackRoute {
  return {
    prefix: cfg.prefix,
    handle(rawValue, s, ctx, chatId, msgId) {
      const value = cfg.caseSensitive ? rawValue : rawValue.toLowerCase();
      const arr = s[cfg.field];
      const idx = arr.findIndex((x) => (cfg.caseSensitive ? x : x.toLowerCase()) === value);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(cfg.caseSensitive ? value : rawValue);
      saveSettings(s);
      const togglePrefix = cfg.prefix.slice(4, -1);
      showToggleEditor(
        ctx,
        chatId,
        cfg.label,
        arr,
        toggleSettingsKb(cfg.presets, arr, togglePrefix, cfg.caseSensitive),
        msgId,
      );
    },
  };
}

const CUSTOM_ROUTES: readonly CallbackRoute[] = [
  {
    prefix: "set:loc:",
    handle(value, s, ctx, chatId, msgId) {
      const idx = s.locations.indexOf(value);
      if (idx >= 0) s.locations.splice(idx, 1);
      else s.locations.push(value);
      // "Anywhere" is mutually exclusive with specific locations
      if (value === "Anywhere" && s.locations.includes("Anywhere")) {
        s.locations = ["Anywhere"];
      } else {
        s.locations = s.locations.filter((l) => l !== "Anywhere");
      }
      saveSettings(s);
      const locPresets = isRemoteOnly(s.workArrangement)
        ? REMOTE_LOCATION_PRESETS
        : LOCATION_SETTINGS_PRESETS;
      showToggleEditor(
        ctx,
        chatId,
        "Locations",
        s.locations,
        toggleSettingsKb(locPresets, s.locations, "loc"),
        msgId,
      );
    },
  },
  {
    prefix: "set:wf:",
    handle(value, s, ctx, chatId, msgId) {
      const wasBefore = isRemoteOnly(s.workArrangement);
      const idx = s.workArrangement.indexOf(value);
      if (idx >= 0) s.workArrangement.splice(idx, 1);
      else s.workArrangement.push(value);
      // switching between remote/non-remote resets locations (different presets apply)
      if (wasBefore !== isRemoteOnly(s.workArrangement)) s.locations = [];
      saveSettings(s);
      showWorkFormatEditor(ctx, chatId, s, msgId);
    },
  },
  {
    prefix: "set:lang:",
    handle(value, s, ctx, chatId, msgId) {
      if (value !== "English") {
        const idx = s.acceptedLanguages.indexOf(value);
        if (idx >= 0) s.acceptedLanguages.splice(idx, 1);
        else s.acceptedLanguages.push(value);
        saveSettings(s);
      }
      showToggleEditor(
        ctx,
        chatId,
        "Languages",
        s.acceptedLanguages,
        toggleSettingsKb(LANGUAGE_PRESETS, s.acceptedLanguages, "lang"),
        msgId,
      );
    },
  },
  {
    prefix: "set:src:",
    handle(value, s, ctx, chatId, msgId) {
      const idx = s.enabledSources.indexOf(value);
      if (idx >= 0 && s.enabledSources.length > 1) s.enabledSources.splice(idx, 1);
      else if (idx < 0) s.enabledSources.push(value);
      saveSettings(s);
      showSourcesEditor(ctx, chatId, s, msgId);
    },
  },
  {
    prefix: "set:intv:",
    handle(raw, s, ctx, chatId, msgId) {
      const value = Math.max(
        POLLING.MIN_INTERVAL_MINUTES,
        Math.min(POLLING.MAX_INTERVAL_MINUTES, parseInt(raw, 10) || 30),
      );
      s.checkIntervalMinutes = value;
      saveSettings(s);
      fireIntervalChanged();
      showIntervalEditor(ctx, chatId, value, msgId);
    },
  },
  {
    prefix: "set:age:",
    handle(raw, s, ctx, chatId, msgId) {
      const value = Math.max(0, Math.min(30, parseInt(raw, 10) || 2));
      s.maxJobAgeDays = value;
      saveSettings(s);
      showAgeEditor(ctx, chatId, value, msgId);
    },
  },
  {
    prefix: "set:sal:",
    handle(raw, s, ctx, chatId, msgId) {
      s.minSalaryUsd = Math.max(0, Math.min(1_000_000, parseInt(raw, 10) || 0));
      saveSettings(s);
      showSalaryEditor(ctx, chatId, s, msgId);
    },
  },
  {
    prefix: "set:rm:",
    handle(raw, s, ctx, chatId, msgId) {
      const parts = raw.split(":");
      const key = parts[0] ?? "";
      if (!isArrayKey(key)) return undefined;
      const value = parts.slice(1).join(":");
      s[key] = s[key].filter((item) => item !== value);
      saveSettings(s);
      showArrayEditor(ctx, chatId, key, s, msgId);
      return `Removed "${value}"`;
    },
  },
];

const ALL_ROUTES: readonly CallbackRoute[] = [
  ...TOGGLE_ROUTES.map(buildToggleRoute),
  ...CUSTOM_ROUTES,
];

interface EditorConfig {
  inputKey?: SettingKey;
  show(ctx: Context, chatId: string, s: UserSettings, msgId: number | undefined): void;
}

const EDITOR_MAP: Readonly<Record<string, EditorConfig>> = {
  roles: {
    show: (ctx, cid, s, mid) =>
      showToggleEditor(
        ctx,
        cid,
        "Roles",
        s.roles,
        toggleSettingsKb(ROLE_PRESETS, s.roles, "role"),
        mid,
      ),
  },
  seniority: {
    show: (ctx, cid, s, mid) =>
      showToggleEditor(
        ctx,
        cid,
        "Seniority",
        s.seniority,
        toggleSettingsKb(WIZARD_SENIORITY, s.seniority, "sen", false),
        mid,
      ),
  },
  jobTypes: {
    show: (ctx, cid, s, mid) =>
      showToggleEditor(
        ctx,
        cid,
        "Job Type",
        s.jobTypes,
        toggleSettingsKb(JOB_TYPE_PRESETS, s.jobTypes, "jtype", false),
        mid,
      ),
  },
  locations: {
    inputKey: "locations",
    show(ctx, cid, s, mid) {
      const presets = isRemoteOnly(s.workArrangement)
        ? REMOTE_LOCATION_PRESETS
        : LOCATION_SETTINGS_PRESETS;
      showToggleEditor(
        ctx,
        cid,
        "Locations",
        s.locations,
        toggleSettingsKb(presets, s.locations, "loc"),
        mid,
      );
    },
  },
  excludeKeywords: {
    inputKey: "excludeKeywords",
    show: (ctx, cid, s, mid) =>
      showToggleEditor(
        ctx,
        cid,
        "Exclude",
        s.excludeKeywords,
        toggleSettingsKb(EXCLUDE_PRESETS, s.excludeKeywords, "excl", false),
        mid,
      ),
  },
  workArrangement: { show: (ctx, cid, s, mid) => showWorkFormatEditor(ctx, cid, s, mid) },
  acceptedLanguages: {
    show: (ctx, cid, s, mid) =>
      showToggleEditor(
        ctx,
        cid,
        "Languages",
        s.acceptedLanguages,
        toggleSettingsKb(LANGUAGE_PRESETS, s.acceptedLanguages, "lang"),
        mid,
      ),
  },
  enabledSources: { show: (ctx, cid, s, mid) => showSourcesEditor(ctx, cid, s, mid) },
  minSalaryUsd: { show: (ctx, cid, s, mid) => showSalaryEditor(ctx, cid, s, mid) },
  checkIntervalMinutes: {
    inputKey: "checkIntervalMinutes",
    show: (ctx, cid, s, mid) => showIntervalEditor(ctx, cid, s.checkIntervalMinutes, mid),
  },
  maxJobAgeDays: {
    inputKey: "maxJobAgeDays",
    show: (ctx, cid, s, mid) => showAgeEditor(ctx, cid, s.maxJobAgeDays, mid),
  },
};

export function showEditorForKey(
  ctx: Context,
  chatId: string,
  key: SettingKey,
  s: UserSettings,
  msgId?: number,
): void {
  if (isArrayKey(key) && !EDITOR_MAP[key]) {
    showArrayEditor(ctx, chatId, key, s, msgId);
    return;
  }
  const editor = EDITOR_MAP[key];
  if (editor) editor.show(ctx, chatId, s, msgId);
}

export const settingsCallbacks = new Composer<Context>();

settingsCallbacks.callbackQuery(/^set:/, async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = String(ctx.chat!.id);
  const msgId = ctx.callbackQuery.message?.message_id;

  if (data === "set:togglePause") {
    const s = await loadSettingsOrReject(ctx, chatId);
    if (!s) return;
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

  if (data === "set:noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  for (const route of ALL_ROUTES) {
    if (!data.startsWith(route.prefix)) continue;
    const value = data.slice(route.prefix.length);
    const s = await loadSettingsOrReject(ctx, chatId);
    if (!s) return;
    const toast = route.handle(value, s, ctx, chatId, msgId);
    await ctx.answerCallbackQuery(toast || undefined);
    return;
  }

  const raw = data.slice(4);
  if (!(raw in LABELS)) return;
  const key = raw as SettingKey;
  const s = await loadSettingsOrReject(ctx, chatId);
  if (!s) return;
  await ctx.answerCallbackQuery();
  waitingForInput.delete(chatId);

  // register for text input if this editor accepts typed values
  const editor = EDITOR_MAP[key];
  if (isArrayKey(key) || editor?.inputKey) {
    waitingForInput.set(chatId, {
      key: editor?.inputKey ?? key,
      messageId: msgId!,
      createdAt: Date.now(),
    });
  }

  showEditorForKey(ctx, chatId, key, s, msgId);
});
