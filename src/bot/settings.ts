import { Composer, GrammyError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { UserSettings, loadSettings, saveSettings } from "../db";
import { formatSettings } from "./format";
import { logError } from "../lib/logger";
import { WIZARD } from "../constants";
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

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── State ──────────────────────────────────────────────────────────────────

export const waitingForInput = new Map<
  string,
  { key: SettingKey; messageId: number; createdAt: number }
>();

let onIntervalChanged: (() => void) | null = null;

export function setOnIntervalChanged(cb: () => void): void {
  onIntervalChanged = cb;
}

// ── Sweep stale input sessions ─────────────────────────────────────────────

export function sweepStaleInputs(): void {
  const now = Date.now();
  for (const [id, e] of waitingForInput) {
    if (now - e.createdAt > WIZARD.INPUT_TTL_MS) waitingForInput.delete(id);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function isArrayKey(key: string): key is ArraySettingKey {
  return key === "keywords" || key === "excludeKeywords" || key === "locations";
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
  for (let i = 0; i < items.length; i += 2) {
    for (const item of items.slice(i, i + 2)) kb.text(`\u2715 ${item}`, `set:rm:${key}:${item}`);
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
  const set = new Set(caseSensitive ? selected : selected.map((s) => s.toLowerCase()));
  const isSelected = (item: string) => set.has(caseSensitive ? item : item.toLowerCase());
  const kb = new InlineKeyboard();
  for (let i = 0; i < presets.length; i += 3) {
    for (const item of presets.slice(i, i + 3))
      kb.text(isSelected(item) ? `\u2705 ${item}` : item, `set:${prefix}:${item}`);
    kb.row();
  }
  return kb.text("\u2190 Back", "set:back");
}

function salarySettingsKb(current: number, locations: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const regionPresets = getSalaryPresets(new Set(locations));
  const hasSkip = regionPresets[0]?.value === 0;
  const presets = [{ label: "No min", value: 0 }, ...(hasSkip ? regionPresets.slice(1) : regionPresets)];
  for (let i = 0; i < presets.length; i += 3) {
    for (const p of presets.slice(i, i + 3))
      kb.text(current === p.value ? `\u2705 ${p.label}` : p.label, `set:sal:${p.value}`);
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

// ── Show helpers (exported for use by commands.ts and text handler) ────────

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

// ── Callback handler ───────────────────────────────────────────────────────

export const settingsCallbacks = new Composer<Context>();

settingsCallbacks.callbackQuery(/^set:/, async (ctx) => {
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

  const toggleConfigs: Record<
    string,
    {
      prefix: string;
      field: keyof Pick<UserSettings, "roles" | "seniority" | "jobTypes" | "excludeKeywords">;
      label: string;
      presets: string[];
      caseSensitive: boolean;
    }
  > = {
    "set:role:": {
      prefix: "set:role:",
      field: "roles",
      label: "Roles",
      presets: ROLE_PRESETS,
      caseSensitive: true,
    },
    "set:sen:": {
      prefix: "set:sen:",
      field: "seniority",
      label: "Seniority",
      presets: WIZARD_SENIORITY,
      caseSensitive: false,
    },
    "set:jtype:": {
      prefix: "set:jtype:",
      field: "jobTypes",
      label: "Job Type",
      presets: JOB_TYPE_PRESETS,
      caseSensitive: false,
    },
    "set:excl:": {
      prefix: "set:excl:",
      field: "excludeKeywords",
      label: "Exclude",
      presets: EXCLUDE_PRESETS,
      caseSensitive: false,
    },
  };

  for (const [pfx, cfg] of Object.entries(toggleConfigs)) {
    if (!data.startsWith(pfx)) continue;
    const value = cfg.caseSensitive ? data.slice(pfx.length) : data.slice(pfx.length).toLowerCase();
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    const arr = s[cfg.field];
    const idx = arr.findIndex((x) => (cfg.caseSensitive ? x : x.toLowerCase()) === value);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(cfg.caseSensitive ? value : data.slice(pfx.length));
    saveSettings(s);
    await ctx.answerCallbackQuery();
    showToggleEditor(
      ctx,
      chatId,
      cfg.label,
      arr,
      toggleSettingsKb(cfg.presets, arr, pfx.slice(4, -1), cfg.caseSensitive),
      msgId,
    );
    return;
  }

  // Location toggle
  if (data.startsWith("set:loc:")) {
    const value = data.slice(8);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    const idx = s.locations.indexOf(value);
    if (idx >= 0) s.locations.splice(idx, 1);
    else s.locations.push(value);
    // "Anywhere" clears others, selecting anything else removes "Anywhere"
    if (value === "Anywhere" && s.locations.includes("Anywhere")) {
      s.locations = ["Anywhere"];
    } else {
      s.locations = s.locations.filter((l) => l !== "Anywhere");
    }
    saveSettings(s);
    await ctx.answerCallbackQuery();
    const locPresets = isRemoteOnly(s.workArrangement) ? REMOTE_LOCATION_PRESETS : LOCATION_SETTINGS_PRESETS;
    showToggleEditor(
      ctx,
      chatId,
      "Locations",
      s.locations,
      toggleSettingsKb(locPresets, s.locations, "loc"),
      msgId,
    );
    return;
  }

  // Work format toggle
  if (data.startsWith("set:wf:")) {
    const value = data.slice(7);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    const wasBefore = isRemoteOnly(s.workArrangement);
    const idx = s.workArrangement.indexOf(value);
    if (idx >= 0) s.workArrangement.splice(idx, 1);
    else s.workArrangement.push(value);
    const isNow = isRemoteOnly(s.workArrangement);
    // Reset locations when switching between Remote and non-Remote (different preset formats)
    if (wasBefore !== isNow) s.locations = [];
    saveSettings(s);
    await ctx.answerCallbackQuery();
    const wfSet = new Set(s.workArrangement);
    const wfKb = new InlineKeyboard();
    for (const p of WORK_FORMAT_PRESETS)
      wfKb.text(wfSet.has(p) ? `\u2705 ${p}` : p, `set:wf:${p}`).row();
    wfKb.text("\u2190 Back", "set:back");
    const sel = s.workArrangement.length > 0 ? s.workArrangement.join(", ") : "any";
    editOrSend(
      ctx,
      chatId,
      `\u2699\ufe0f Work Format\n\nSelected: ${sel}\nTap to toggle.`,
      wfKb,
      msgId,
    ).catch((e) => logError("showWfEditor", e));
    return;
  }

  // Language toggle
  if (data.startsWith("set:lang:")) {
    const value = data.slice(9);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    if (value !== "English") {
      const idx = s.acceptedLanguages.indexOf(value);
      if (idx >= 0) s.acceptedLanguages.splice(idx, 1);
      else s.acceptedLanguages.push(value);
      saveSettings(s);
    }
    await ctx.answerCallbackQuery();
    showToggleEditor(
      ctx,
      chatId,
      "Languages",
      s.acceptedLanguages,
      toggleSettingsKb(LANGUAGE_PRESETS, s.acceptedLanguages, "lang"),
      msgId,
    );
    return;
  }

  // Source toggle
  if (data.startsWith("set:src:")) {
    const name = data.slice(8);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    const idx = s.enabledSources.indexOf(name);
    if (idx >= 0 && s.enabledSources.length > 1) s.enabledSources.splice(idx, 1);
    else if (idx < 0) s.enabledSources.push(name);
    saveSettings(s);
    await ctx.answerCallbackQuery();
    const srcSet = new Set(s.enabledSources);
    const srcKb = new InlineKeyboard();
    for (let i = 0; i < ALL_SOURCE_NAMES.length; i += 2) {
      for (const n of ALL_SOURCE_NAMES.slice(i, i + 2))
        srcKb.text(srcSet.has(n) ? `\u2705 ${n}` : n, `set:src:${n}`);
      srcKb.row();
    }
    srcKb.text("\u2190 Back", "set:back");
    const count = s.enabledSources.length;
    editOrSend(
      ctx,
      chatId,
      `\u2699\ufe0f Sources (${count} of ${ALL_SOURCE_NAMES.length} active)\n\nTap to toggle.`,
      srcKb,
      msgId,
    ).catch((e) => logError("showSrcEditor", e));
    return;
  }

  if (data === "set:noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  // Interval preset
  if (data.startsWith("set:intv:")) {
    const value = parseInt(data.slice(9), 10);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    s.checkIntervalMinutes = value;
    saveSettings(s);
    await ctx.answerCallbackQuery();
    if (onIntervalChanged) onIntervalChanged();
    // Re-render interval editor with updated value
    const kb = new InlineKeyboard();
    for (const v of [15, 30, 60])
      kb.text(value === v ? `\u2705 ${v} min` : `${v} min`, `set:intv:${v}`);
    kb.row();
    for (const v of [120, 360])
      kb.text(value === v ? `\u2705 ${v} min` : `${v} min`, `set:intv:${v}`);
    kb.row().text("\u2190 Back", "set:back");
    editOrSend(
      ctx,
      chatId,
      `\u2699\ufe0f Interval\n\nCurrently: every ${value} minutes.\nTap or type a number.`,
      kb,
      msgId,
    ).catch((e) => logError("showIntervalEditor", e));
    return;
  }

  // Max age preset
  if (data.startsWith("set:age:")) {
    const value = parseInt(data.slice(8), 10);
    const s = loadSettings(chatId);
    if (!s) {
      await ctx.answerCallbackQuery("Run /start first.");
      return;
    }
    s.maxJobAgeDays = value;
    saveSettings(s);
    await ctx.answerCallbackQuery();
    // Re-render max age editor with updated value
    const kb = new InlineKeyboard();
    for (const v of [1, 2, 3]) kb.text(value === v ? `\u2705 ${v}d` : `${v}d`, `set:age:${v}`);
    kb.row();
    const noLim = value === 0 ? "\u2705 No limit" : "No limit";
    kb.text(value === 7 ? `\u2705 7d` : "7d", `set:age:7`).text(noLim, `set:age:0`);
    kb.row().text("\u2190 Back", "set:back");
    editOrSend(
      ctx,
      chatId,
      `\u2699\ufe0f Max age\n\nCurrently: ${value > 0 ? `${value} days` : "no limit"}.\nTap or type a number.`,
      kb,
      msgId,
    ).catch((e) => logError("showAgeEditor", e));
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
  waitingForInput.delete(chatId);

  const editorMap: Record<string, () => void> = {
    roles: () =>
      showToggleEditor(
        ctx,
        chatId,
        "Roles",
        s.roles,
        toggleSettingsKb(ROLE_PRESETS, s.roles, "role"),
        msgId,
      ),
    seniority: () =>
      showToggleEditor(
        ctx,
        chatId,
        "Seniority",
        s.seniority,
        toggleSettingsKb(WIZARD_SENIORITY, s.seniority, "sen", false),
        msgId,
      ),
    jobTypes: () =>
      showToggleEditor(
        ctx,
        chatId,
        "Job Type",
        s.jobTypes,
        toggleSettingsKb(JOB_TYPE_PRESETS, s.jobTypes, "jtype", false),
        msgId,
      ),
    locations: () => {
      waitingForInput.set(chatId, { key: "locations", messageId: msgId!, createdAt: Date.now() });
      const presets = isRemoteOnly(s.workArrangement) ? REMOTE_LOCATION_PRESETS : LOCATION_SETTINGS_PRESETS;
      showToggleEditor(
        ctx,
        chatId,
        "Locations",
        s.locations,
        toggleSettingsKb(presets, s.locations, "loc"),
        msgId,
      );
    },
    excludeKeywords: () => {
      waitingForInput.set(chatId, {
        key: "excludeKeywords",
        messageId: msgId!,
        createdAt: Date.now(),
      });
      showToggleEditor(
        ctx,
        chatId,
        "Exclude",
        s.excludeKeywords,
        toggleSettingsKb(EXCLUDE_PRESETS, s.excludeKeywords, "excl", false),
        msgId,
      );
    },
    workArrangement: () => {
      const wfSet = new Set(s.workArrangement);
      const wfKb = new InlineKeyboard();
      for (const p of WORK_FORMAT_PRESETS)
        wfKb.text(wfSet.has(p) ? `\u2705 ${p}` : p, `set:wf:${p}`).row();
      wfKb.text("\u2190 Back", "set:back");
      const sel = s.workArrangement.length > 0 ? s.workArrangement.join(", ") : "any";
      editOrSend(
        ctx,
        chatId,
        `\u2699\ufe0f Work Format\n\nSelected: ${sel}\nTap to toggle.`,
        wfKb,
        msgId,
      ).catch((e) => logError("showWfEditor", e));
    },
    acceptedLanguages: () =>
      showToggleEditor(
        ctx,
        chatId,
        "Languages",
        s.acceptedLanguages,
        toggleSettingsKb(LANGUAGE_PRESETS, s.acceptedLanguages, "lang"),
        msgId,
      ),
    enabledSources: () => {
      const enabled = s.enabledSources.length > 0 ? s.enabledSources : ALL_SOURCE_NAMES;
      const srcSet = new Set(enabled);
      const srcKb = new InlineKeyboard();
      for (let i = 0; i < ALL_SOURCE_NAMES.length; i += 2) {
        for (const n of ALL_SOURCE_NAMES.slice(i, i + 2))
          srcKb.text(srcSet.has(n) ? `\u2705 ${n}` : n, `set:src:${n}`);
        srcKb.row();
      }
      srcKb.text("\u2190 Back", "set:back");
      editOrSend(
        ctx,
        chatId,
        `\u2699\ufe0f Sources (${enabled.length} of ${ALL_SOURCE_NAMES.length} active)\n\nTap to toggle.`,
        srcKb,
        msgId,
      ).catch((e) => logError("showSrcEditor", e));
    },
  };
  if (editorMap[key]) {
    editorMap[key]();
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
  if (numKey === "checkIntervalMinutes") {
    const cur = s[numKey];
    const kb = new InlineKeyboard();
    for (const v of [15, 30, 60])
      kb.text(cur === v ? `\u2705 ${v} min` : `${v} min`, `set:intv:${v}`);
    kb.row();
    for (const v of [120, 360])
      kb.text(cur === v ? `\u2705 ${v} min` : `${v} min`, `set:intv:${v}`);
    kb.row().text("\u2190 Back", "set:back");
    editOrSend(
      ctx,
      chatId,
      `\u2699\ufe0f Interval\n\nCurrently: every ${cur} minutes.\nTap or type a number.`,
      kb,
      msgId,
    ).catch((e) => logError("showNumericEditor", e));
  } else {
    const cur = s[numKey];
    const kb = new InlineKeyboard();
    for (const v of [1, 2, 3]) kb.text(cur === v ? `\u2705 ${v}d` : `${v}d`, `set:age:${v}`);
    kb.row();
    const noLim = cur === 0 ? "\u2705 No limit" : "No limit";
    kb.text(cur === 7 ? `\u2705 7d` : "7d", `set:age:7`).text(noLim, `set:age:0`);
    kb.row().text("\u2190 Back", "set:back");
    editOrSend(
      ctx,
      chatId,
      `\u2699\ufe0f Max age\n\nCurrently: ${cur > 0 ? `${cur} days` : "no limit"}.\nTap or type a number.`,
      kb,
      msgId,
    ).catch((e) => logError("showNumericEditor", e));
  }
});
