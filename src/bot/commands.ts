import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import {
  UserSettings,
  isOnboarded,
  loadSettings,
  saveSettings,
  deleteUserData,
  getAllSourceHealth,
} from "../db";
import { sources } from "../sources";
import { getStoredJob, sendJob } from "./delivery";
import { getPollStats, clearUserState } from "../pipeline/polling";
import { escapeHtml } from "./format";
import { replyKb } from "./keyboards";
import { wizardSessions, sweepStaleWizards, createWizardSession } from "./wizard";
import { waitingForInput, sweepStaleInputs, showSettings } from "./settings";
import { DELIVERY } from "../constants";

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function formatActivity(s: UserSettings | null, stats: ReturnType<typeof getPollStats>): string {
  const status = s?.paused
    ? "\u23f8 Paused"
    : `\u2705 Active \u00b7 checking every ${s?.checkIntervalMinutes ?? 30} min`;

  // db-persisted counters (survive restarts), unlike per-cycle stats below
  const counters = `Sources: ${s?.enabledSources.length ?? 0} active\nTotal jobs sent: ${s?.jobsSent ?? 0}`;

  if (!stats) {
    return (s?.jobsSent ?? 0) === 0
      ? `${status}\n\n${counters}\n\nWaiting for the first check...`
      : `${status}\n\n${counters}`;
  }

  const lastCheck = `Last check:\n  Scanned: ${stats.checked} jobs\n  Sent: ${stats.sent}`;

  const skipped = stats.rejected
    .slice(-5)
    .map(
      (r) =>
        `\u2022 <a href="${escapeHtml(r.url)}">${escapeHtml(truncate(r.title, DELIVERY.MAX_TITLE_LEN))}</a> - ${escapeHtml(r.reason)}`,
    );

  let hint = "";
  if (stats.checked > 0 && stats.sent === 0) {
    hint =
      "\ud83d\udca1 No matches found. Try broadening your filters - add more technologies or lower the salary threshold.";
  } else if (stats.checked > 50 && stats.sent > 0 && stats.sent <= 2) {
    hint =
      "\ud83d\udca1 Few matches. You might get more by adding technologies or relaxing seniority level.";
  }

  return [
    status,
    counters,
    lastCheck,
    skipped.length > 0 ? `Recently skipped:\n${skipped.join("\n")}` : "",
    hint,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function replyActivity(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  await ctx.reply(formatActivity(loadSettings(chatId), getPollStats(chatId)), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

async function replySources(ctx: Context): Promise<void> {
  const healthRows = getAllSourceHealth();
  const healthMap = new Map(healthRows.map((r) => [r.source, r]));
  const now = Date.now();

  const lines: string[] = ["<b>Source Health</b>", ""];
  for (const source of sources) {
    const h = healthMap.get(source.name);
    if (!h) {
      lines.push(`\u2753 ${source.name}  -  no data yet`);
      continue;
    }
    const ago = h.last_success_at ? formatAgo(now - h.last_success_at) : "never";
    const icon = h.fail_streak > 0 ? "\u26a0\ufe0f" : "\u2705";
    const suffix =
      h.fail_streak > 0 ? ` (${h.fail_streak >= 3 ? "streak" : "fail"}: ${h.fail_streak})` : "";
    lines.push(`${icon} ${source.name}  -  ${h.last_job_count ?? 0} jobs  ${ago}${suffix}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export const commandHandlers = new Composer<Context>();

commandHandlers.command("start", async (ctx) => {
  sweepStaleWizards();
  sweepStaleInputs();
  const chatId = String(ctx.chat.id);
  if (wizardSessions.has(chatId)) {
    await ctx.reply("Setup is already in progress. Use /cancel to start over.");
    return;
  }

  const s = loadSettings(chatId);
  if (s && isOnboarded(s)) {
    await ctx.reply("You're already set up. Use /settings to make changes.", {
      reply_markup: replyKb(s.paused),
    });
    return;
  }

  const msg = await ctx.reply(
    "Hey! I'm Ahead - your personal job scout.\n\n" +
      "I check thousands of jobs daily, filter out the noise, and send you only what fits your stack, level, and salary.\n\n" +
      "Quick setup - takes about a minute.",
    { reply_markup: new InlineKeyboard().text("Set up my filters \u2192", "wiz:start") },
  );
  wizardSessions.set(chatId, createWizardSession(chatId, msg.message_id));
});

commandHandlers.command("delete", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const s = loadSettings(chatId);
  if (!s) {
    await ctx.reply("No data to delete.");
    return;
  }
  const session = wizardSessions.get(chatId);
  if (session?.messageId) {
    ctx.api.editMessageText(chatId, session.messageId, "Setup cancelled.").catch(() => {});
  }
  deleteUserData(chatId);
  clearUserState(chatId);
  wizardSessions.delete(chatId);
  waitingForInput.delete(chatId);
  await ctx.reply("All your data has been deleted. Send /start to set up again.");
});

commandHandlers.command("settings", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const s = loadSettings(chatId);
  if (!s || !isOnboarded(s)) {
    await ctx.reply("Run /start first to set up your preferences.");
    return;
  }
  showSettings(ctx, chatId, s);
});

commandHandlers.command("cancel", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const session = wizardSessions.get(chatId);
  if (session) {
    if (session.messageId) {
      ctx.api.editMessageText(chatId, session.messageId, "Setup cancelled.").catch(() => {});
    }
    wizardSessions.delete(chatId);
    await ctx.reply("Cancelled. Send /start to try again.");
    return;
  }
  waitingForInput.delete(chatId);
  const s = loadSettings(chatId);
  if (s) showSettings(ctx, chatId, s);
  else await ctx.reply("Cancelled.");
});

commandHandlers.command("status", replyActivity);

commandHandlers.command("sources", replySources);

commandHandlers.hears("\u2699\ufe0f Settings", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const s = loadSettings(chatId);
  if (s && isOnboarded(s)) showSettings(ctx, chatId, s);
  else await ctx.reply("Run /start first to set up your preferences.");
});

commandHandlers.hears("\ud83d\udcca Activity", replyActivity);

commandHandlers.hears("\ud83d\udd0c Sources", replySources);

commandHandlers.hears(/^(\u23f8 Pause|\u25b6 Resume)$/, async (ctx) => {
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

commandHandlers.callbackQuery(/^job:(.+)$/, async (ctx) => {
  const stored = getStoredJob(ctx.match[1]!);
  if (!stored) {
    await ctx.answerCallbackQuery("This job listing has expired.");
    return;
  }
  await ctx.answerCallbackQuery();
  await sendJob(String(ctx.chat!.id), stored.job, stored.parsed);
});
