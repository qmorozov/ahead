import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { isOnboarded, loadSettings, saveSettings, deleteUserData, getAllSourceHealth } from "../db";
import { sources } from "../sources";
import { getStoredJob, sendJob } from "./delivery";
import { getPollStats, clearUserState } from "../pipeline/polling";
import { replyKb } from "./presets";
import { wizardSessions, sweepStaleWizards } from "./wizard";
import { waitingForInput, sweepStaleInputs, showSettings } from "./settings";

// ── Sweep both Maps ────────────────────────────────────────────────────────

function sweepStale(): void {
  sweepStaleWizards();
  sweepStaleInputs();
}

// ── Activity reply (shared by /status command and keyboard button) ─────────

async function replyActivity(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const s = loadSettings(chatId);
  const stats = getPollStats(chatId);

  const lines: string[] = [];

  // Status line
  if (s?.paused) {
    lines.push("\u23f8 Paused");
  } else {
    lines.push(`\u2705 Active \u00b7 checking every ${s?.checkIntervalMinutes ?? 30} min`);
  }

  // Lifetime stats (always available, persisted in DB)
  const totalSent = s?.jobsSent ?? 0;
  const srcCount = s?.enabledSources.length ?? 0;
  lines.push("", `Sources: ${srcCount} active`, `Total jobs sent: ${totalSent}`);

  if (stats) {
    // Per-cycle stats (available after first poll since restart)
    lines.push("", `Last check:`, `  Scanned: ${stats.checked} jobs`, `  Sent: ${stats.sent}`);

    if (stats.rejected.length > 0) {
      lines.push("", "Recently skipped:");
      for (const r of stats.rejected.slice(-5)) {
        const title = r.title.length > 40 ? r.title.slice(0, 40) + "..." : r.title;
        lines.push(`\u2022 <a href="${r.url}">${title}</a> \u2014 ${r.reason}`);
      }
    }

    // Smart hint
    if (stats.checked > 0 && stats.sent === 0) {
      lines.push(
        "",
        "\ud83d\udca1 No matches found. Try broadening your filters \u2014 add more technologies or lower the salary threshold.",
      );
    } else if (stats.checked > 50 && stats.sent > 0 && stats.sent <= 2) {
      lines.push(
        "",
        "\ud83d\udca1 Few matches. You might get more by adding technologies or relaxing seniority level.",
      );
    }
  } else if (totalSent === 0) {
    lines.push("", "Waiting for the first check...");
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// ── Sources reply (shared by /sources command and keyboard button) ─────────

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
      lines.push(`\u2753 ${source.name}  \u2014  no data yet`);
      continue;
    }
    const ago = h.last_success_at ? formatAgo(now - h.last_success_at) : "never";
    if (h.fail_streak >= 3) {
      lines.push(`\u26a0\ufe0f ${source.name}  \u2014  ${h.last_job_count ?? 0} jobs  ${ago}  (streak: ${h.fail_streak})`);
    } else if (h.fail_streak > 0) {
      lines.push(`\u26a0\ufe0f ${source.name}  \u2014  ${h.last_job_count ?? 0} jobs  ${ago}  (fail: ${h.fail_streak})`);
    } else {
      lines.push(`\u2705 ${source.name}  \u2014  ${h.last_job_count ?? 0} jobs  ${ago}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

// ── Composer ───────────────────────────────────────────────────────────────

export const commandHandlers = new Composer<Context>();

commandHandlers.command("start", async (ctx) => {
  sweepStale();
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
  wizardSessions.set(chatId, {
    step: "welcome",
    messageId: msg.message_id,
    chatId,
    createdAt: Date.now(),
    roles: new Set(),
    technologies: [],
    seniority: new Set(),
    jobTypes: new Set(),
    workArrangement: new Set(),
    locations: new Set(),
    minSalaryUsd: 0,
    acceptedLanguages: new Set(["English"]),
    excludeKeywords: new Set(),
  });
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
