// score jobs from logs/jobs.jsonl against each user's settings
// run: npx tsx scripts/score-jobs.ts
import fs from "fs";
import path from "path";
import { loadSettings } from "../src/db";
import {
  buildScoringContext,
  scoreJob,
  computeThreshold,
  type ScoreResult,
  type ScorerName,
} from "../src/pipeline/filter";
import { Job, JobSchema } from "../src/types";

const LOG_PATH = path.join(process.cwd(), "logs", "jobs.jsonl");

if (!fs.existsSync(LOG_PATH)) {
  console.error(`No log file found at ${LOG_PATH}`);
  console.error("Run the bot with DEBUG=1 to collect job data first.");
  process.exit(1);
}

const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
if (lines.length === 0) {
  console.error("Log file is empty.");
  process.exit(1);
}

const entriesByChat = new Map<string, Job[]>();
let parseErrors = 0;

for (const line of lines) {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    parseErrors++;
    continue;
  }
  const entry = raw as Record<string, unknown>;
  const chatId = entry.chatId as string | undefined;
  if (!chatId) {
    parseErrors++;
    continue;
  }

  const jobResult = JobSchema.safeParse(entry);
  if (!jobResult.success) {
    parseErrors++;
    continue;
  }

  const list = entriesByChat.get(chatId) ?? [];
  list.push(jobResult.data);
  entriesByChat.set(chatId, list);
}

if (parseErrors > 0) console.warn(`Skipped ${parseErrors} malformed log lines.\n`);
console.log(
  `Loaded ${lines.length - parseErrors} jobs for ${entriesByChat.size} user(s) from ${LOG_PATH}\n`,
);

const ALL_SCORERS: ScorerName[] = [
  "excludedTech",
  "seniority",
  "titleKeywords",
  "tagOverlap",
  "descKeywords",
  "stackMatch",
  "role",
  "foreignTech",
  "freshness",
  "salary",
  "excludeKeywords",
  "jobQuality",
];

interface ScoredJob {
  job: Job;
  result: ScoreResult;
  threshold: number;
  pass: boolean;
}

const allScored: ScoredJob[] = [];

for (const [chatId, jobs] of entriesByChat) {
  const settings = loadSettings(chatId);
  if (!settings) {
    console.warn(`⚠ chatId ${chatId}: settings not found, skipping ${jobs.length} jobs.\n`);
    continue;
  }

  const ctx = buildScoringContext(settings);
  const threshold = computeThreshold(ctx);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`User ${chatId}  ·  ${jobs.length} jobs  ·  threshold ${threshold}`);
  console.log("═".repeat(60));

  for (const job of jobs) {
    const result = scoreJob(job, null, ctx);
    const pass = result.score >= threshold;
    allScored.push({ job, result, threshold, pass });

    const label = job.company ? `${job.title} @ ${job.company}` : job.title;
    console.log(`\n"${label}"`);

    for (const [name, value] of Object.entries(result.breakdown)) {
      if (value === undefined) continue;
      const sign = value >= 0 ? "+" : "";
      console.log(`  ${name.padEnd(16)} ${sign}${String(value).padStart(3)}`);
    }

    console.log("  " + "─".repeat(40));
    console.log(
      `  Total: ${result.score}  normalized: ${result.normalized}%  ${pass ? "✅ PASS" : "❌ FAIL"}  (threshold: ${threshold})`,
    );
    if (result.signals.length > 0) console.log(`  Signals: ${result.signals.join(", ")}`);
  }
}

if (allScored.length === 0) {
  console.log("\nNo jobs scored.");
  process.exit(0);
}

const passed = allScored.filter((s) => s.pass);
const failed = allScored.filter((s) => !s.pass);

console.log(`\n\n${"═".repeat(60)}`);
console.log("AGGREGATED SUMMARY");
console.log("═".repeat(60));
console.log(`Total: ${allScored.length}  ·  Passed: ${passed.length}  ·  Failed: ${failed.length}`);

// Top 5 rejection signals
const signalCounts = new Map<string, number>();
for (const { result } of failed) {
  for (const sig of result.signals) {
    signalCounts.set(sig, (signalCounts.get(sig) ?? 0) + 1);
  }
}
if (signalCounts.size > 0) {
  console.log("\nTop rejection signals:");
  const sorted = [...signalCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted.slice(0, 5)) {
    console.log(`  ${String(count).padStart(4)}x  ${reason}`);
  }
}

// Closest misses: FAIL jobs within 5 points of threshold
const closeMisses = failed
  .filter((s) => s.result.score >= 0)
  .map((s) => ({ ...s, gap: s.threshold - s.result.score }))
  .filter((s) => s.gap <= 5)
  .sort((a, b) => a.gap - b.gap);

if (closeMisses.length > 0) {
  console.log(`\nClosest misses (within 5 pts of threshold):`);
  for (const { job, result, threshold, gap } of closeMisses.slice(0, 10)) {
    const label = job.company ? `${job.title} @ ${job.company}` : job.title;
    console.log(
      `  -${gap} pts  score ${result.score}/${threshold}  "${label}"  [${result.signals.join(", ")}]`,
    );
  }
}

// Scorer averages: PASS vs FAIL side by side
function scorerAverages(items: ScoredJob[]): Map<ScorerName, number> {
  const sums = new Map<ScorerName, number>();
  const counts = new Map<ScorerName, number>();
  for (const { result } of items) {
    for (const name of ALL_SCORERS) {
      const val = result.breakdown[name];
      if (val === undefined) continue;
      sums.set(name, (sums.get(name) ?? 0) + val);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const avgs = new Map<ScorerName, number>();
  for (const name of ALL_SCORERS) {
    const count = counts.get(name) ?? 0;
    avgs.set(name, count > 0 ? (sums.get(name) ?? 0) / count : 0);
  }
  return avgs;
}

const passAvg = scorerAverages(passed);
const failAvg = scorerAverages(failed);

console.log("\nScorer averages (PASS vs FAIL):");
console.log(
  `  ${"scorer".padEnd(16)}  ${"PASS".padStart(6)}  ${"FAIL".padStart(6)}  ${"delta".padStart(6)}`,
);
console.log(`  ${"─".repeat(16)}  ${"─".repeat(6)}  ${"─".repeat(6)}  ${"─".repeat(6)}`);
for (const name of ALL_SCORERS) {
  const p = passAvg.get(name) ?? 0;
  const f = failAvg.get(name) ?? 0;
  const delta = p - f;
  const sign = delta >= 0 ? "+" : "";
  console.log(
    `  ${name.padEnd(16)}  ${p.toFixed(1).padStart(6)}  ${f.toFixed(1).padStart(6)}  ${(sign + delta.toFixed(1)).padStart(6)}`,
  );
}
