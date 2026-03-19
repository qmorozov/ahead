import { Composer } from "grammy";
import type { Context } from "grammy";
import { loadSettings, saveSettings } from "../db";
import { parseCommaSeparated, parseCommaSeparatedRaw } from "../lib/utils";
import { WIZARD } from "../constants";
import type { WizardStep, ToggleField } from "./presets";
import {
  EXCLUDE_PRESETS,
  REMOTE_LOCATION_PRESETS,
  LOCATION_SETTINGS_PRESETS,
  isRemoteOnly,
} from "./presets";
import { wizardSessions, renderWizardStep, setOnWizardComplete } from "./wizard";
import { wizardCallbacks } from "./wizard";
import {
  waitingForInput,
  isArrayKey,
  showSettings,
  showArrayEditor,
  showToggleEditor,
  toggleSettingsKb,
  settingsCallbacks,
  setOnIntervalChanged as setOnIntervalChanged_settings,
} from "./settings";
import { commandHandlers } from "./commands";

// ── Compose all sub-handlers ───────────────────────────────────────────────

export const handlers = new Composer<Context>();

handlers.use(commandHandlers);
handlers.use(wizardCallbacks);
handlers.use(settingsCallbacks);

// ── Text input handler ─────────────────────────────────────────────────────
// Lives here because it bridges wizard sessions (wizard.ts) and
// settings input (settings.ts) — the only cross-cutting concern.

handlers.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const session = wizardSessions.get(chatId);
  if (session) {
    const textSteps: WizardStep[] = [
      "roles",
      "technologies",
      "seniority",
      "locations",
      "languages",
      "excludes",
    ];
    if (!textSteps.includes(session.step)) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    const isTech = session.step === "technologies";
    const items = (isTech ? parseCommaSeparated(text) : parseCommaSeparatedRaw(text)).filter(
      (i) => i.length <= WIZARD.MAX_ITEM_LENGTH,
    );
    if (items.length === 0) return;

    if (isTech) {
      for (const item of items) {
        if (session.technologies.length >= WIZARD.MAX_ARRAY_ITEMS) break;
        if (!session.technologies.includes(item)) session.technologies.push(item);
      }
    } else {
      const fieldMap: Record<string, ToggleField> = {
        roles: "roles",
        seniority: "seniority",
        locations: "locations",
        languages: "acceptedLanguages",
        excludes: "excludeKeywords",
      };
      const field = fieldMap[session.step]!;
      const set = session[field] as Set<string>;
      for (const item of items) {
        if (set.size >= WIZARD.MAX_ARRAY_ITEMS) break;
        set.add(item);
      }
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
    if (pending.key === "checkIntervalMinutes" && onIntervalChangedCb) onIntervalChangedCb();
  } else if (isArrayKey(pending.key)) {
    const parser = pending.key === "keywords" ? parseCommaSeparated : parseCommaSeparatedRaw;
    const newItems = parser(text).filter((i) => i.length <= WIZARD.MAX_ITEM_LENGTH);
    const merged = new Set([...s[pending.key], ...newItems]);
    s[pending.key] = [...merged].slice(0, WIZARD.MAX_ARRAY_ITEMS);
    saveSettings(s);
    if (pending.key === "excludeKeywords") {
      showToggleEditor(
        ctx,
        chatId,
        "Exclude",
        s.excludeKeywords,
        toggleSettingsKb(EXCLUDE_PRESETS, s.excludeKeywords, "excl", false),
        pending.messageId,
      );
    } else if (pending.key === "locations") {
      const isRem = isRemoteOnly(s.workArrangement);
      showToggleEditor(
        ctx,
        chatId,
        "Locations",
        s.locations,
        toggleSettingsKb(
          isRem ? REMOTE_LOCATION_PRESETS : LOCATION_SETTINGS_PRESETS,
          s.locations,
          "loc",
        ),
        pending.messageId,
      );
    } else {
      showArrayEditor(ctx, chatId, pending.key, s, pending.messageId);
    }
  }
});

// ── Re-exported callback setters ───────────────────────────────────────────
// index.ts imports these from handlers.ts — we keep the same public API.

let onIntervalChangedCb: (() => void) | null = null;

export { setOnWizardComplete };

export function setOnIntervalChanged(cb: () => void): void {
  onIntervalChangedCb = cb;
  setOnIntervalChanged_settings(cb);
}
