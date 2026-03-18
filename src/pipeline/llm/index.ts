// LLM orchestrator - tries providers in order, falls through on failure, caches results.
import { z } from "zod";
import { config } from "../../config";
import { getCachedParse, setCachedParse, getLlmQuotaValue, setLlmQuotaValue } from "../../db";
import { hasContent, ParsedJob, ParsedJobSchema } from "../../types";
import { log, debug } from "../../lib/logger";
import { stripHtml, normalizeSeniority } from "../../lib/utils";
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

const parseTimestamps: number[] = (() => {
  const raw = getLlmQuotaValue("parse_timestamps");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as number[];
    const cutoff = Date.now() - HOUR_MS;
    return Array.isArray(arr) ? arr.filter((t) => t > cutoff) : [];
  } catch {
    return [];
  }
})();

function isParseAvailable(): boolean {
  if (providers.length === 0) return false;
  const cutoff = Date.now() - HOUR_MS;
  const idx = parseTimestamps.findIndex((t) => t > cutoff);
  if (idx > 0) parseTimestamps.splice(0, idx);
  else if (idx === -1) parseTimestamps.length = 0;
  return parseTimestamps.length < LLM.PARSES_PER_HOUR;
}

function recordParse(): void {
  parseTimestamps.push(Date.now());
  setLlmQuotaValue("parse_timestamps", JSON.stringify(parseTimestamps));
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
    const error = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
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

/**
 * Pre-filter jobs by relevance using a lightweight LLM call.
 * Fail-open: if LLM is down or returns garbage, all jobs pass through.
 */
export async function classifyBatch(
  jobs: ClassifyInput[],
  userProfile: string,
): Promise<Set<number>> {
  if (providers.length === 0) return new Set(jobs.map((j) => j.index));

  const relevant = new Set<number>();

  for (let i = 0; i < jobs.length; i += LLM.CLASSIFY_BATCH_SIZE) {
    const batch = jobs.slice(i, i + LLM.CLASSIFY_BATCH_SIZE);
    const list = batch
      .map((j, idx) => `${idx + 1}. ${j.title} - ${j.company} [${j.tags.slice(0, 4).join(", ")}]`)
      .join("\n");

    const nums = await classifySingleBatch(batch.length, userProfile, list);

    if (!nums) {
      for (const j of batch) relevant.add(j.index);
    } else {
      for (const n of nums) {
        const job = batch[n - 1];
        if (job) relevant.add(job.index);
      }
      debug(`Classify batch: ${batch.length} jobs → ${nums.length} relevant`);
    }
  }

  return relevant;
}

/** Returns 1-based indices of relevant jobs, or null if LLM can't answer. */
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
  } catch {
    return null;
  }
}

/**
 * Full job description parsing with the heavy model.
 * Cached in DB for 30 days. On invalid output, retries once
 * with the Zod error fed back into the prompt.
 */
export async function parseJobDescription(
  jobKey: string,
  description: string,
): Promise<ParsedJob | null> {
  const cached = getCachedParse(jobKey);
  if (cached) {
    debug(`LLM cache hit [${jobKey}]: ${cached.primaryTags.join(", ")}`);
    return cached;
  }

  if (!isParseAvailable()) {
    debug(`LLM skip [${jobKey}]: quota ${parseTimestamps.length}/${LLM.PARSES_PER_HOUR}`);
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

  recordParse();
  log(`LLM parsing [${jobKey}] (${parseTimestamps.length}/${LLM.PARSES_PER_HOUR})`);

  return parseWithRetry(jobKey, prepareDescription(description));
}

async function parseWithRetry(jobKey: string, prepared: string): Promise<ParsedJob> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
    const prompt = lastError
      ? `${PARSE_PROMPT}\n\nYour previous response had an error: ${lastError}\nFix and return valid JSON.`
      : PARSE_PROMPT;

    const raw = await callLLM("heavy", prompt, prepared, { maxTokens: 500 });
    const { parsed, error } = tryParseLLMOutput(raw);

    if (parsed && hasContent(parsed)) {
      setCachedParse(jobKey, parsed);
      log(`LLM parsed [${jobKey}]: ${parsed.primaryTags.join(", ")}`);
      return parsed;
    }

    // Nothing to retry with - LLM returned empty or null
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

/** Lightweight tagging - only tags + seniority. Used when heavy parse budget is exceeded. */
export async function quickTagJob(jobKey: string, description: string): Promise<ParsedJob | null> {
  const cached = getCachedParse(jobKey);
  if (cached && cached.requirements.length > 0) return cached;
  if (!description || description.trim().length < MIN_DESCRIPTION_LENGTH) return null;

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

  setCachedParse(jobKey, parsed);
  debug(`Quick-tag [${jobKey}]: ${tags.join(", ")}`);
  return parsed;
}
