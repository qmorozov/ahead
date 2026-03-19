import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
} from "../db";
import { formatSettings } from "./format";
import { logError } from "../lib/logger";
import { WIZARD } from "../constants";
import {
  WizardSession,
  ROLE_PRESETS,
  WIZARD_SENIORITY,
  WORK_FORMAT_PRESETS,
  REMOTE_LOCATION_PRESETS,
  REGION_COUNTRIES,
  LANGUAGE_PRESETS,
  EXCLUDE_PRESETS,
  ALL_SOURCE_NAMES,
  PRIMARY_STACK_SIZE,
  STEP_FLOW,
  STEP_BACK,
  WIZ_TOGGLE,
  JOB_TYPE_PRESETS,
  getTechPresets,
  getSalaryPresets,
  isRemoteOnly,
  replyKb,
  toggleGrid,
  stepLabel,
  setSelectedText,
  addNavButtons,
} from "./presets";

// ── State ──────────────────────────────────────────────────────────────────

export const wizardSessions = new Map<string, WizardSession>();

let onWizardComplete: ((chatId: string) => void) | null = null;

export function setOnWizardComplete(cb: (chatId: string) => void): void {
  onWizardComplete = cb;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function buildStepContent(session: WizardSession): { text: string; kb: InlineKeyboard } {
  // Step 1: Roles
  if (session.step === "roles") {
    const text =
      `${stepLabel("roles")}\n\n` +
      `What kind of role are you looking for?` +
      `${setSelectedText(session.roles)}`;
    const kb = toggleGrid(ROLE_PRESETS, session.roles, "role", 3);
    addNavButtons(kb, "roles", session.roles.size > 0);
    return { text, kb };
  }

  // Step 2: Technologies
  if (session.step === "technologies") {
    const techSet = new Set(session.technologies);
    const presets = getTechPresets(session.roles);
    const selected =
      session.technologies.length > 0 ? `\n\n\u2705 ${session.technologies.join(", ")}` : "";
    const hint = `\n\n\ud83d\udca1 Tap your main technologies first - they get higher priority.`;
    const text =
      `${stepLabel("technologies")}\n\n` +
      `What technologies do you work with?` +
      `${selected}${hint}`;
    const kb = new InlineKeyboard();
    for (let i = 0; i < presets.length; i += 3) {
      for (const p of presets.slice(i, i + 3))
        kb.text(techSet.has(p) ? `\u2705 ${p}` : p, `wiz:tech:${p}`);
      kb.row();
    }
    addNavButtons(kb, "technologies", session.technologies.length > 0);
    return { text, kb };
  }

  // Step 3: Seniority
  if (session.step === "seniority") {
    const text =
      `${stepLabel("seniority")}\n\n` +
      `What levels are you open to?\n` +
      `Pick several if flexible (e.g. Senior + Middle).` +
      `${setSelectedText(session.seniority)}`;
    const kb = toggleGrid(WIZARD_SENIORITY, session.seniority, "sen", 3);
    addNavButtons(kb, "seniority", session.seniority.size > 0);
    return { text, kb };
  }

  // Step 4: Job Types
  if (session.step === "jobTypes") {
    const text =
      `${stepLabel("jobTypes")}\n\n` +
      `What type of employment?` +
      `${setSelectedText(session.jobTypes)}`;
    const kb = toggleGrid(JOB_TYPE_PRESETS, session.jobTypes, "jt", 3);
    addNavButtons(kb, "jobTypes", session.jobTypes.size > 0);
    return { text, kb };
  }

  // Step 5: Work Format
  if (session.step === "workFormat") {
    const text =
      `${stepLabel("workFormat")}\n\n` +
      `How do you want to work?` +
      `${setSelectedText(session.workArrangement)}`;
    const kb = toggleGrid(WORK_FORMAT_PRESETS, session.workArrangement, "wf", 3);
    addNavButtons(kb, "workFormat", session.workArrangement.size > 0);
    return { text, kb };
  }

  // Step 6: Location
  if (session.step === "locations") {
    if (isRemoteOnly(session.workArrangement)) {
      const text =
        `${stepLabel("locations")}\n\n` +
        `Any region restrictions?\n` +
        `Skip = anywhere.` +
        `${setSelectedText(session.locations)}`;
      const kb = toggleGrid(REMOTE_LOCATION_PRESETS, session.locations, "loc", 2);
      addNavButtons(kb, "locations", session.locations.size > 0);
      return { text, kb };
    }

    const selectedRegion = [...session.locations].find((l) => REGION_COUNTRIES[l]);
    const kb = new InlineKeyboard();

    if (!selectedRegion) {
      const text =
        `${stepLabel("locations")}\n\n` +
        `Pick your region, then select a country.\n` +
        `Or type your own.` +
        `${setSelectedText(session.locations)}`;
      for (const r of Object.keys(REGION_COUNTRIES)) {
        kb.text(session.locations.has(r) ? `\u2705 ${r}` : r, `wiz:loc:${r}`);
      }
      kb.row();
      addNavButtons(kb, "locations", session.locations.size > 0);
      return { text, kb };
    }

    const countries = REGION_COUNTRIES[selectedRegion] ?? [];
    const text =
      `${stepLabel("locations")}\n\n` +
      `Top IT hubs in ${selectedRegion}.\n` +
      `Or type your own.` +
      `${setSelectedText(session.locations)}`;
    kb.text(`\u2705 ${selectedRegion}`, `wiz:loc:${selectedRegion}`).row();
    for (let i = 0; i < countries.length; i += 2) {
      for (const c of countries.slice(i, i + 2))
        kb.text(session.locations.has(c) ? `\u2705 ${c}` : c, `wiz:loc:${c}`);
      kb.row();
    }
    addNavButtons(kb, "locations", session.locations.size > 0);
    return { text, kb };
  }

  // Step 7: Salary
  if (session.step === "salary") {
    const salaryPresets = getSalaryPresets(session.locations);
    const current = session.minSalaryUsd;
    const sel = current > 0 ? `\n\nSelected: $${current / 1000}k+` : "";
    const text =
      `${stepLabel("salary")}\n\n` +
      `Minimum annual salary (USD)?\n` +
      `Jobs without salary info will still appear.` +
      `${sel}`;
    const kb = new InlineKeyboard();
    for (let i = 0; i < salaryPresets.length; i += 3) {
      for (const p of salaryPresets.slice(i, i + 3))
        kb.text(current === p.value ? `\u2705 ${p.label}` : p.label, `wiz:sal:${p.value}`);
      kb.row();
    }
    addNavButtons(kb, "salary", true);
    return { text, kb };
  }

  // Step 8: Languages
  if (session.step === "languages") {
    const text =
      `${stepLabel("languages")}\n\n` +
      `Which languages are OK for job descriptions?\n` +
      `English is always on. Type your own if needed.` +
      `${setSelectedText(session.acceptedLanguages)}`;
    const kb = toggleGrid(LANGUAGE_PRESETS, session.acceptedLanguages, "lang", 3);
    addNavButtons(kb, "languages", true);
    return { text, kb };
  }

  // Step 9: Exclude
  const text =
    `${stepLabel("excludes")}\n\n` +
    `Anything to avoid?\n` +
    `Tap or type your own.` +
    `${setSelectedText(session.excludeKeywords)}`;
  const kb = toggleGrid(EXCLUDE_PRESETS, session.excludeKeywords, "excl", 3);
  addNavButtons(kb, "excludes", true, true);
  return { text, kb };
}

export async function renderWizardStep(ctx: Context, session: WizardSession): Promise<void> {
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

  const allTechs = session.technologies.slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.primaryStack = allTechs.slice(0, PRIMARY_STACK_SIZE);
  s.keywords = allTechs;
  s.roles = [...session.roles].slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.seniority = [...session.seniority].slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.jobTypes = [...session.jobTypes].slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.workArrangement = [...session.workArrangement].slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.locations = [...session.locations]
    .filter((l) => l.toLowerCase() !== "anywhere")
    .slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.minSalaryUsd = session.minSalaryUsd;
  const langs = [...session.acceptedLanguages];
  if (!langs.includes("English")) langs.unshift("English");
  s.acceptedLanguages = langs.slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.excludeKeywords = [...session.excludeKeywords].slice(0, WIZARD.MAX_ARRAY_ITEMS);
  s.enabledSources = [...ALL_SOURCE_NAMES];
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

  await ctx.api.sendMessage(chatId, "Tap the button below anytime to change your filters.", {
    reply_markup: replyKb(false),
  });
  wizardSessions.delete(chatId);
  if (onWizardComplete) onWizardComplete(chatId);
}

// ── Sweep stale wizard sessions ────────────────────────────────────────────

export function sweepStaleWizards(): void {
  const now = Date.now();
  for (const [id, s] of wizardSessions) {
    if (now - s.createdAt > WIZARD.TTL_MS) wizardSessions.delete(id);
  }
}

// ── Callback handler ───────────────────────────────────────────────────────

export const wizardCallbacks = new Composer<Context>();

wizardCallbacks.callbackQuery(/^wiz:/, async (ctx) => {
  const session = wizardSessions.get(String(ctx.chat!.id));
  if (!session) {
    await ctx.answerCallbackQuery("Session expired. Send /start to begin again.");
    return;
  }
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery.data;

  if (data === "wiz:noop") return;

  if (data === "wiz:start") {
    session.step = "roles";
    await renderWizardStep(ctx, session);
    return;
  }

  if (data === "wiz:back") {
    const prev = STEP_BACK[session.step];
    if (prev) {
      session.step = prev;
      await renderWizardStep(ctx, session);
    }
    return;
  }

  if (data === "wiz:done" || data === "wiz:skip") {
    const next = STEP_FLOW[session.step];
    if (!next || next === "finish") {
      // Must have at least roles or technologies to be onboarded
      if (session.roles.size === 0 && session.technologies.length === 0) {
        session.step = "roles";
        await renderWizardStep(ctx, session);
        return;
      }
      await finishWizard(ctx, session);
    } else {
      session.step = next;
      await renderWizardStep(ctx, session);
    }
    return;
  }

  // Salary selection
  const salMatch = data.match(/^wiz:sal:(\d+)$/);
  if (salMatch) {
    session.minSalaryUsd = parseInt(salMatch[1]!, 10);
    await renderWizardStep(ctx, session);
    return;
  }

  // Individual tech toggle
  const techMatch = data.match(/^wiz:tech:(.+)$/);
  if (techMatch) {
    const value = techMatch[1]!;
    const idx = session.technologies.indexOf(value);
    if (idx >= 0) session.technologies.splice(idx, 1);
    else if (session.technologies.length < WIZARD.MAX_ARRAY_ITEMS) session.technologies.push(value);
    await renderWizardStep(ctx, session);
    return;
  }

  // Set-based toggles (roles, seniority, jobTypes, locations, excludes)
  const toggleMatch = data.match(/^wiz:(role|sen|jt|wf|loc|lang|excl):(.+)$/);
  if (toggleMatch) {
    const field = WIZ_TOGGLE[toggleMatch[1]!]!;
    const value = toggleMatch[2]!;
    const set = session[field] as Set<string>;

    if (field === "locations") {
      const lower = value.toLowerCase();
      if (lower === "anywhere") {
        session.locations.clear();
        session.locations.add("Anywhere");
      } else if (set.has(value)) {
        set.delete(value);
        // Deselecting a region: also remove its countries
        const regionCountries = REGION_COUNTRIES[value];
        if (regionCountries) for (const c of regionCountries) set.delete(c);
      } else {
        session.locations.delete("Anywhere");
        set.add(value);
      }
    } else {
      if (set.has(value)) set.delete(value);
      else set.add(value);
    }

    await renderWizardStep(ctx, session);
  }
});
