import Groq from "groq-sdk";
import { config } from "./config";
import { getCachedParse, setCachedParse } from "./db";
import { hasContent } from "./format";
import { log, logError } from "./logger";
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

const PROMPT = `Extract structured data from this job posting.
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
- primaryTags should be mostly specific technologies, but include 1-2 role categories if clearly applicable (e.g., "devops", "frontend", "mobile")
- Always return at least 3 primaryTags
- If a section is not found, return empty array`;

const groq = config.groqApiKey ? new Groq({ apiKey: config.groqApiKey }) : null;

const RPM_LIMIT = 6;
const PARSES_PER_HOUR = 20;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

const requestTimestamps: number[] = [];
const parseTimestamps: number[] = [];
let quotaExhaustedAt = 0;

async function waitForRateLimit(): Promise<void> {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - 60_000) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RPM_LIMIT) break;
    const waitMs = Math.max(100, requestTimestamps[0]! + 60_000 - Date.now() + 100);
    log(`Rate limit: waiting ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  requestTimestamps.push(Date.now());
}

const MAX_INPUT_CHARS = 2000;

async function callLLM(description: string): Promise<ParsedJob> {
  if (!groq) return emptyParsed();

  const text = stripHtml(description);
  const truncated =
    text.length > MAX_INPUT_CHARS ? text.substring(0, MAX_INPUT_CHARS) + "..." : text;
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await waitForRateLimit();

      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: truncated },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });

      const raw = response.choices[0]?.message?.content ?? "";
      const result = ParsedJobSchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        log("LLM returned invalid structure, using empty result");
        return emptyParsed();
      }

      return {
        ...result.data,
        requirements: result.data.requirements.slice(0, 8),
        niceToHave: result.data.niceToHave.slice(0, 5),
        responsibilities: result.data.responsibilities.slice(0, 5),
        primaryTags: result.data.primaryTags.slice(0, 8).map((t) => t.toLowerCase()),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "";

      if (/tokens per day|tokens per hour/i.test(msg)) {
        log("LLM quota exhausted, pausing for 1h");
        quotaExhaustedAt = Date.now();
        return emptyParsed();
      }

      const isRetryable =
        /429|rate/i.test(msg) ||
        /5\d\d/.test(msg) ||
        /ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);

      if (isRetryable && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        log(`LLM retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      logError("LLM", error);
      return emptyParsed();
    }
  }

  return emptyParsed();
}

function isAvailable(): boolean {
  if (!groq) return false;
  if (quotaExhaustedAt > 0 && Date.now() - quotaExhaustedAt < QUOTA_COOLDOWN_MS) return false;

  const now = Date.now();
  while (parseTimestamps.length > 0 && parseTimestamps[0]! < now - 3_600_000) {
    parseTimestamps.shift();
  }
  return parseTimestamps.length < PARSES_PER_HOUR;
}

export async function parseJobDescription(
  jobKey: string,
  description: string,
): Promise<ParsedJob | null> {
  const cached = getCachedParse(jobKey);
  if (cached) return cached;

  if (!isAvailable()) return null;
  if (!description || description.trim().length < 50) return null;

  parseTimestamps.push(Date.now());
  const parsed = await callLLM(description);

  if (hasContent(parsed)) {
    setCachedParse(jobKey, parsed);
  }

  return parsed;
}
