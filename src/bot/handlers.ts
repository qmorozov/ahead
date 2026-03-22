import { Composer } from "grammy";
import type { Context } from "grammy";
import { loadSettings, saveSettings } from "../db";
import { parseCommaSeparated, parseCommaSeparatedRaw } from "../lib/utils";
import { WIZARD } from "../constants";
import type { ToggleField } from "./presets";
import { wizardSessions, renderWizardStep, setOnWizardComplete } from "./wizard";
import { wizardCallbacks } from "./wizard";
import {
  waitingForInput,
  isArrayKey,
  showSettings,
  showEditorForKey,
  settingsCallbacks,
  setOnIntervalChanged,
  fireIntervalChanged,
} from "./settings";
import { commandHandlers } from "./commands";

export const handlers = new Composer<Context>();

handlers.use(commandHandlers);
handlers.use(wizardCallbacks);
handlers.use(settingsCallbacks);

// free-text input bridges wizard and settings (both accept typed values)
handlers.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // Steps that accept typed text and the session field they write to
  const TEXT_FIELDS: Record<string, ToggleField | "technologies"> = {
    roles: "roles",
    technologies: "technologies",
    seniority: "seniority",
    locations: "locations",
    languages: "acceptedLanguages",
    excludes: "excludeKeywords",
  };

  const session = wizardSessions.get(chatId);
  if (session) {
    const field = TEXT_FIELDS[session.step];
    if (!field) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    const items = (
      field === "technologies" ? parseCommaSeparated(text) : parseCommaSeparatedRaw(text)
    ).filter((i) => i.length <= WIZARD.MAX_ITEM_LENGTH);
    if (items.length === 0) return;

    if (field === "technologies") {
      for (const item of items) {
        if (session.technologies.length >= WIZARD.MAX_ARRAY_ITEMS) break;
        if (!session.technologies.includes(item)) session.technologies.push(item);
      }
    } else {
      const set = session[field];
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
    s[pending.key] =
      pending.key === "checkIntervalMinutes"
        ? Math.min(num, 1440)
        : Math.min(num, 30);
    saveSettings(s);
    showSettings(ctx, chatId, s, pending.messageId);
    if (pending.key === "checkIntervalMinutes") fireIntervalChanged();
  } else if (isArrayKey(pending.key)) {
    const parser = pending.key === "keywords" ? parseCommaSeparated : parseCommaSeparatedRaw;
    const newItems = parser(text).filter((i) => i.length <= WIZARD.MAX_ITEM_LENGTH);
    const merged = new Set([...s[pending.key], ...newItems]);
    s[pending.key] = [...merged].slice(0, WIZARD.MAX_ARRAY_ITEMS);
    saveSettings(s);
    showEditorForKey(ctx, chatId, pending.key, s, pending.messageId);
  }
});

// re-exported so index.ts can wire callbacks through a single import
export { setOnWizardComplete };
export { setOnIntervalChanged };
