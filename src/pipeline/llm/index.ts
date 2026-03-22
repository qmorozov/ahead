import { z } from "zod";
import { config } from "../../config";
import {
  getCachedParse,
  setCachedParse,
  countRecentParses,
  recordParseTimestamp,
  pruneParseTimestamps,
} from "../../db";
import { hasContent, ParsedJob, ParsedJobSchema } from "../../types";
import { log, debug } from "../../lib/logger";
import { stripHtml } from "../../lib/utils";
import { normalizeSeniority } from "../../lib/seniority";
import { LLM } from "../../constants";
import type { LLMProvider, CallOptions, ModelTier } from "./types";
import { createGroqProvider } from "./groq";
import { createCerebrasProvider } from "./cerebras";
import { PARSE_PROMPT, QUICK_TAG_PROMPT, CLASSIFY_PROMPT } from "./prompts";

const providers: LLMProvider[] = [
  config.groqApiKey ? createGroqProvider(config.groqApiKey) : null,
  config.cerebrasApiKey ? createCerebrasProvider(config.cerebrasApiKey) : null,
].filter((p): p is LLMProvider => p !== null);

async function callLLM(
  tier: ModelTier,
  systemPrompt: string,
  userContent: string,
  options?: CallOptions,
): Promise<string | null> {
  for (const provider of providers) {
    if (!provider.isAvailable()) continue;
    const result = await provider.call(tier, systemPrompt, userContent, options);
    if (result !== null) return result;
  }
  return null;
}

// Hourly parse budget - shared across all providers to prevent 429 storms
const HOUR_MS = 3_600_000;

// DB persists for restart recovery; in-memory count is authoritative at runtime
pruneParseTimestamps(Date.now() - HOUR_MS);
let parseCount = countRecentParses(Date.now() - HOUR_MS);
let lastPruneAt = Date.now();

function isParseAvailable(): boolean {
  if (providers.length === 0) return false;
  // Re-sync from DB at most once per minute to account for expired timestamps
  const now = Date.now();
  if (now - lastPruneAt > 60_000) {
    pruneParseTimestamps(now - HOUR_MS);
    parseCount = countRecentParses(now - HOUR_MS);
    lastPruneAt = now;
  }
  return parseCount < LLM.PARSES_PER_HOUR;
}

function recordParse(): void {
  parseCount++;
  recordParseTimestamp(Date.now());
}

// Strip HTML, truncate to budget, wrap in XML tags for prompt injection defense
function prepareDescription(description: string): string {
  let text = stripHtml(description);
  if (text.length > LLM.MAX_INPUT_CHARS) {
    const slice = text.substring(0, LLM.MAX_INPUT_CHARS);
    const lastBreak = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf(".\n"),
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
    );
    text =
      slice.substring(
        0,
        lastBreak > LLM.MAX_INPUT_CHARS * 0.7 ? lastBreak + 1 : LLM.MAX_INPUT_CHARS,
      ) + "...";
  }
  return `<job_description>\n${text}\n</job_description>`;
}

const EMPTY_PARSED: ParsedJob = {
  requirements: [],
  niceToHave: [],
  responsibilities: [],
  seniority: null,
  salary: null,
  primaryTags: [],
  workArrangement: null,
  locationRestriction: null,
};

function postProcess(data: z.infer<typeof ParsedJobSchema>): ParsedJob {
  return {
    ...data,
    salary: data.salary && /\d/.test(data.salary) ? data.salary : null,
    requirements: data.requirements.slice(0, 8),
    niceToHave: data.niceToHave.slice(0, 5),
    responsibilities: data.responsibilities.slice(0, 5),
    primaryTags: data.primaryTags.slice(0, 8).map((t) => t.toLowerCase()),
  };
}

function humanizeZodError(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const field = String(issue.path[0] ?? "field");
      if (issue.code === "invalid_value" && "values" in issue) {
        const vals = (issue as { values: unknown[] }).values;
        return `"${field}" must be one of: ${vals.join(", ")}`;
      }
      return `"${field}": ${issue.message}`;
    })
    .join("; ");
}

function tryParseLLMOutput(raw: string | null | undefined): {
  parsed: ParsedJob | null;
  error: string | null;
} {
  if (!raw) {
    debug("LLM output: empty response");
    return { parsed: null, error: "empty response" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    debug(`LLM output: invalid JSON: ${raw.slice(0, 200)}`);
    return { parsed: null, error: `invalid JSON: ${raw.slice(0, 100)}` };
  }

  const result = ParsedJobSchema.safeParse(json);
  if (!result.success) {
    const error = humanizeZodError(result.error.issues);
    debug(`LLM output: validation failed: ${error.slice(0, 200)}`);
    return { parsed: null, error };
  }

  return { parsed: postProcess(result.data), error: null };
}

const QuickTagSchema = z.object({
  primaryTags: z.array(z.string()).default([]),
  seniority: z.string().nullable().default(null),
});

const MAX_PARSE_ATTEMPTS = 2;
const MIN_DESCRIPTION_LENGTH = 50;

export interface ClassifyInput {
  index: number;
  title: string;
  company: string;
  tags: string[];
}

// fail-open all jobs pass through if LLM is unavailable
export async function classifyBatch(
  jobs: ClassifyInput[],
  userProfile: string,
): Promise<Set<number>> {
  if (providers.length === 0) return new Set(jobs.map((j) => j.index));

  const relevant = new Set<number>();
  let consecutiveFailures = 0;

  for (let i = 0; i < jobs.length; i += LLM.CLASSIFY_BATCH_SIZE) {
    const batch = jobs.slice(i, i + LLM.CLASSIFY_BATCH_SIZE);

    if (consecutiveFailures >= 2) {
      for (const j of batch) relevant.add(j.index);
      continue;
    }

    const list = batch
      .map((j, idx) => `${idx + 1}. ${j.title} - ${j.company} [${j.tags.slice(0, 4).join(", ")}]`)
      .join("\n");

    const nums = await classifySingleBatch(batch.length, userProfile, list);

    if (!nums) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        log("LLM classify unavailable - using score-only filter");
      }
      for (const j of batch) relevant.add(j.index);
    } else {
      consecutiveFailures = 0;
      for (const n of nums) {
        const job = batch[n - 1];
        if (job) relevant.add(job.index);
      }
      debug(`Classify batch: ${batch.length} jobs → ${nums.length} relevant`);
    }
  }

  return relevant;
}

async function classifySingleBatch(
  batchSize: number,
  userProfile: string,
  jobList: string,
): Promise<number[] | null> {
  try {
    const raw = await callLLM("light", CLASSIFY_PROMPT, `Profile: ${userProfile}\n\n${jobList}`, {
      maxTokens: 150,
    });
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const nums = Array.isArray(parsed.relevant) ? parsed.relevant : null;
    if (!nums || nums.length === 0) return null;

    return nums.filter(
      (n: unknown): n is number =>
        typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= batchSize,
    );
  } catch (err) {
    debug(`Classify batch error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// dedup concurrent parses for the same job
const inFlightParses = new Map<string, Promise<ParsedJob | null>>();
const inFlightQuickTags = new Map<string, Promise<ParsedJob | null>>();

export async function parseJobDescription(
  jobKey: string,
  description: string,
): Promise<ParsedJob | null> {
  const cached = getCachedParse(jobKey);
  if (cached) {
    if (cached.quality === "full" || !isParseAvailable()) {
      debug(`LLM cache hit [${jobKey}]: ${cached.parsed.primaryTags.join(", ")}`);
      return cached.parsed;
    }
    debug(`LLM upgrading quick parse [${jobKey}]`);
  }

  const existing = inFlightParses.get(jobKey);
  if (existing) return existing;

  if (!isParseAvailable()) {
    debug(`LLM skip [${jobKey}]: quota full`);
    return null;
  }
  if (!description || description.trim().length < MIN_DESCRIPTION_LENGTH) {
    debug(`LLM skip [${jobKey}]: description too short`);
    return null;
  }
  if (!providers.some((p) => p.isAvailable())) {
    debug(`LLM skip [${jobKey}]: no provider available`);
    return null;
  }

  log(`LLM parsing [${jobKey}]`);

  const promise = parseWithRetry(jobKey, prepareDescription(description));
  inFlightParses.set(jobKey, promise);
  try {
    return await promise;
  } finally {
    inFlightParses.delete(jobKey);
  }
}

async function parseWithRetry(jobKey: string, prepared: string): Promise<ParsedJob> {
  let lastError: string | null = null;
  let counted = false;

  for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
    const prompt = lastError
      ? `${PARSE_PROMPT}\n\nYour previous response had an error: ${lastError}\nFix and return valid JSON.`
      : PARSE_PROMPT;

    const raw = await callLLM("heavy", prompt, prepared, { maxTokens: 500 });

    if (raw !== null && !counted) {
      recordParse();
      counted = true;
    }

    const { parsed, error } = tryParseLLMOutput(raw);

    if (parsed && hasContent(parsed)) {
      setCachedParse(jobKey, parsed);
      log(`LLM parsed [${jobKey}]: ${parsed.primaryTags.join(", ")}`);
      return parsed;
    }

    if (!error || !raw) {
      log(`LLM empty result [${jobKey}]`);
      return parsed ?? { ...EMPTY_PARSED };
    }

    lastError = error;
    debug(`LLM parse retry [${jobKey}]: ${error.slice(0, 100)}`);
  }

  log(`LLM parse failed after ${MAX_PARSE_ATTEMPTS} attempts [${jobKey}]`);
  return { ...EMPTY_PARSED };
}

export async function quickTagJob(jobKey: string, description: string): Promise<ParsedJob | null> {
  const cached = getCachedParse(jobKey);
  if (cached && cached.parsed.requirements.length > 0) return cached.parsed;
  if (!description || description.trim().length < MIN_DESCRIPTION_LENGTH) return null;

  const existing = inFlightQuickTags.get(jobKey);
  if (existing) return existing;

  const promise = doQuickTag(jobKey, description);
  inFlightQuickTags.set(jobKey, promise);
  try {
    return await promise;
  } finally {
    inFlightQuickTags.delete(jobKey);
  }
}

async function doQuickTag(jobKey: string, description: string): Promise<ParsedJob | null> {
  const raw = await callLLM("light", QUICK_TAG_PROMPT, prepareDescription(description), {
    maxTokens: 200,
  });
  if (!raw) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = QuickTagSchema.safeParse(json);
  if (!result.success) return null;

  const tags = result.data.primaryTags.slice(0, 8).map((t) => t.toLowerCase());
  if (tags.length === 0) return null;

  const parsed: ParsedJob = {
    ...EMPTY_PARSED,
    seniority: normalizeSeniority(result.data.seniority) as ParsedJob["seniority"],
    primaryTags: tags,
  };

  setCachedParse(jobKey, parsed, "quick");
  debug(`Quick-tag [${jobKey}]: ${tags.join(", ")}`);
  return parsed;
}
