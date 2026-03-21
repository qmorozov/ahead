// Score a set of jobs against a user's settings and print detailed breakdowns.
// Run: npx tsx scripts/score-jobs.ts --chatId <id> --file <path>
import fs from "fs";
import { loadSettings } from "../src/db";
import { buildScoringContext, scoreJob, computeThreshold } from "../src/pipeline/filter";
import { Job } from "../src/types";

function usage(): never {
  console.error("Usage: npx tsx scripts/score-jobs.ts --chatId <id> --file <path>");
  process.exit(1);
}

const args = process.argv.slice(2);
const chatIdIdx = args.indexOf("--chatId");
const fileIdx = args.indexOf("--file");

if (chatIdIdx === -1 || fileIdx === -1) usage();

const chatId = args[chatIdIdx + 1];
const filePath = args[fileIdx + 1];
if (!chatId || !filePath) usage();

const settings = loadSettings(chatId);
if (!settings) {
  console.error(`No settings found for chatId: ${chatId}`);
  process.exit(1);
}

let jobs: Job[];
try {
  const raw = fs.readFileSync(filePath, "utf-8");
  jobs = JSON.parse(raw) as Job[];
  if (!Array.isArray(jobs)) throw new Error("Expected JSON array");
} catch (err) {
  console.error(`Failed to read jobs from ${filePath}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const ctx = buildScoringContext(settings);
const threshold = computeThreshold(ctx);

let passed = 0;
let failed = 0;
const rejectionReasons = new Map<string, number>();

for (const job of jobs) {
  const result = scoreJob(job, null, ctx);
  const pass = result.score >= threshold;
  if (pass) passed++;
  else failed++;

  console.log(`"${job.title}${job.company ? ` @ ${job.company}` : ""}"`);

  for (const [name, value] of Object.entries(result.breakdown)) {
    const sign = value >= 0 ? "+" : "";
    const signal = result.signals.length > 0 ? "" : "";
    const pad = name.padEnd(16);
    console.log(`  ${pad} ${sign}${String(value).padStart(3)}  ${signal}`);
  }

  const signalStr = result.signals.length > 0 ? result.signals.join(", ") : "";
  console.log("  " + "─".repeat(40));
  console.log(
    `  Total: ${result.score}  normalized: ${result.normalized}%  ${pass ? "✅ PASS" : "❌ FAIL"}  (threshold: ${threshold})`,
  );
  if (signalStr) console.log(`  Signals: ${signalStr}`);
  console.log();

  if (!pass) {
    for (const sig of result.signals) {
      rejectionReasons.set(sig, (rejectionReasons.get(sig) ?? 0) + 1);
    }
  }
}

console.log("═".repeat(50));
console.log(`Summary: ${passed} passed, ${failed} failed out of ${jobs.length} jobs (threshold: ${threshold})`);

if (rejectionReasons.size > 0) {
  const sorted = [...rejectionReasons.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nTop rejection signals:");
  for (const [reason, count] of sorted.slice(0, 5)) {
    console.log(`  ${count}x  ${reason}`);
  }
}
