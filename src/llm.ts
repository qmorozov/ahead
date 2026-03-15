import pThrottle from "p-throttle";
import pRetry, { AbortError } from "p-retry";
import Groq from "groq-sdk";
import { config } from "./config";
import { getCachedParse, setCachedParse, getLlmQuotaValue, setLlmQuotaValue } from "./db";
import { hasContent } from "./format";
import { log, debug, logError } from "./logger";
import { ParsedJob, ParsedJobSchema } from "./types";
import { stripHtml } from "./utils";

function emptyParsed(): ParsedJob {
  return {
    requirements: [],
    niceToHave: [],
    responsibilities: [],
    seniority: null,
    salary: null,
    primaryTags: [],
  };
}

const PARSE_PROMPT = `Extract structured data from this job posting.
Return JSON with these fields:
- requirements: key requirements (max 8, concise, 1 line each)
- niceToHave: nice-to-have skills (max 5)
- responsibilities: main responsibilities (max 5)
- seniority: one of "Intern","Junior","Middle","Senior","Staff","Lead","Manager" or null
- salary: salary string if mentioned, or null
- primaryTags: 4-8 lowercase tags for the specific technologies, frameworks, libraries, and programming languages required for this role (e.g., "react", "python", "kubernetes", "postgresql", "typescript"). For non-technical roles, use domain tags (e.g., "accounting", "sales", "marketing")

Rules:
- Skip generic filler ("team player", "good communication")
- Skip company descriptions and application instructions
- primaryTags MUST only include technologies, tools, or frameworks explicitly mentioned in the job posting text. Do NOT infer or add technologies not mentioned.
- primaryTags should be mostly specific technologies, but include 1-2 role categories if clearly applicable (e.g., "devops", "frontend", "mobile")
- Always return at least 3 primaryTags
- If a section is not found, return empty array

Example input: "We're looking for a Senior React developer with TypeScript experience. Must know PostgreSQL and Redis. Nice to have: Docker, AWS."
Example output: {"requirements":["React expertise","TypeScript proficiency","PostgreSQL","Redis"],"niceToHave":["Docker","AWS"],"responsibilities":[],"seniority":"Senior","salary":null,"primaryTags":["react","typescript","postgresql","redis","docker","aws"]}`;

const groq = config.groqApiKey ? new Groq({ apiKey: config.groqApiKey }) : null;

const PARSES_PER_HOUR = 40;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_INPUT_CHARS = 1000;
const CLASSIFY_BATCH_SIZE = 10;

const heavyThrottle = pThrottle({ limit: 6, interval: 60_000 });
const lightThrottle = pThrottle({ limit: 20, interval: 60_000 });

const parseTimestamps: number[] = (() => {
  const raw = getLlmQuotaValue("parse_timestamps");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as number[];
    const cutoff = Date.now() - 3_600_000;
    return Array.isArray(arr) ? arr.filter((t) => t > cutoff) : [];
  } catch {
    return [];
  }
})();

let quotaExhaustedAt = parseInt(getLlmQuotaValue("quota_exhausted_at") ?? "", 10) || 0;

function parseLLMOutput(raw: string | null | undefined): ParsedJob {
  if (!raw) return emptyParsed();

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return emptyParsed();
  }

  const result = ParsedJobSchema.safeParse(json);
  if (!result.success) return emptyParsed();

  return {
    ...result.data,
    requirements: result.data.requirements.slice(0, 8),
    niceToHave: result.data.niceToHave.slice(0, 5),
    responsibilities: result.data.responsibilities.slice(0, 5),
    primaryTags: result.data.primaryTags.slice(0, 8).map((t) => t.toLowerCase()),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
}

function isRetryableError(error: unknown): boolean {
  const msg = errorMessage(error);
  return /429|rate/i.test(msg) || /5\d\d/.test(msg) || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

function isQuotaError(error: unknown): boolean {
  const msg = errorMessage(error);
  return /tokens per day|tokens per hour/i.test(msg);
}

function handleQuotaError(): void {
  quotaExhaustedAt = Date.now();
  setLlmQuotaValue("quota_exhausted_at", String(quotaExhaustedAt));
  log("LLM quota exhausted, pausing for 1h");
}

function isQuotaCoolingDown(): boolean {
  return quotaExhaustedAt > 0 && Date.now() - quotaExhaustedAt < QUOTA_COOLDOWN_MS;
}

async function callGroq(
  model: string,
  systemPrompt: string,
  userContent: string,
  throttleFn: ReturnType<typeof pThrottle>,
): Promise<string | null> {
  if (!groq) return null;

  const throttled = throttleFn(async () => {
    const response = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });
    return response.choices[0]?.message?.content ?? null;
  });

  return pRetry(() => throttled(), {
    retries: 2,
    minTimeout: 2000,
    onFailedAttempt: (error) => {
      if (isQuotaError(error)) {
        handleQuotaError();
        throw new AbortError("Quota exhausted");
      }
      if (!isRetryableError(error)) {
        throw new AbortError(`Non-retryable: ${errorMessage(error)}`);
      }
      log(`LLM retry ${error.attemptNumber}/2 (${error.retriesLeft} left)`);
    },
  });
}


interface ClassifyInput {
  index: number;
  title: string;
  company: string;
  tags: string[];
}

export async function classifyBatch(
  jobs: ClassifyInput[],
  userProfile: string,
): Promise<Set<number>> {
  if (!groq || isQuotaCoolingDown()) return new Set(jobs.map((j) => j.index));

  const relevant = new Set<number>();
  for (let i = 0; i < jobs.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = jobs.slice(i, i + CLASSIFY_BATCH_SIZE);
    const list = batch
      .map((j, idx) => `${idx + 1}. ${j.title} — ${j.company} [${j.tags.slice(0, 4).join(", ")}]`)
      .join("\n");

    const prompt = `Given this user profile: ${userProfile}

Which of these jobs are potentially relevant? Return JSON: {"relevant": [1, 3, 5]} with the numbers of relevant jobs. If unsure, include the job. Be generous — it's better to include a borderline job than miss a good one.

${list}`;

    try {
      const raw = await callGroq("llama-3.1-8b-instant", prompt, "", lightThrottle);
      if (raw) {
        const parsed = JSON.parse(raw);
        const nums = Array.isArray(parsed.relevant) ? parsed.relevant : [];
        for (const n of nums) {
          const job = batch[n - 1];
          if (job) relevant.add(job.index);
        }
        debug(`Classify batch: ${batch.length} jobs → ${nums.length} relevant`);
      } else {
        for (const j of batch) relevant.add(j.index);
      }
    } catch (error) {
      logError("LLM classify", error);
      for (const j of batch) relevant.add(j.index);
    }
  }

  return relevant;
}


function isParseAvailable(): boolean {
  if (!groq) return false;
  if (isQuotaCoolingDown()) return false;

  const now = Date.now();
  while (parseTimestamps.length > 0 && (parseTimestamps[0] ?? 0) < now - 3_600_000) {
    parseTimestamps.shift();
  }
  return parseTimestamps.length < PARSES_PER_HOUR;
}

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
    debug(`LLM skip [${jobKey}]: quota ${parseTimestamps.length}/${PARSES_PER_HOUR}`);
    return null;
  }
  if (!description || description.trim().length < 50) {
    debug(`LLM skip [${jobKey}]: description too short`);
    return null;
  }

  parseTimestamps.push(Date.now());
  setLlmQuotaValue("parse_timestamps", JSON.stringify(parseTimestamps));
  log(`LLM parsing [${jobKey}] (${parseTimestamps.length}/${PARSES_PER_HOUR})`);

  const text = stripHtml(description);
  const truncated = text.length > MAX_INPUT_CHARS ? text.substring(0, MAX_INPUT_CHARS) + "..." : text;

  try {
    const raw = await callGroq("llama-3.3-70b-versatile", PARSE_PROMPT, truncated, heavyThrottle);
    const parsed = parseLLMOutput(raw);

    if (hasContent(parsed)) {
      setCachedParse(jobKey, parsed);
      log(`LLM parsed [${jobKey}]: ${parsed.primaryTags.join(", ")}`);
    } else {
      log(`LLM empty result [${jobKey}]`);
    }

    return parsed;
  } catch (error) {
    if (!(error instanceof AbortError && error.message === "Quota exhausted")) {
      logError("LLM", error);
    }
    return null;
  }
}
