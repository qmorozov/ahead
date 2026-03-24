import Parser from "rss-parser";
import { z } from "zod";
import { decodeHTML } from "entities";
import { HTTP_TIMEOUT } from "../config";

export const rssParser = new Parser({
  timeout: HTTP_TIMEOUT,
  headers: { "User-Agent": "ahead-bot/1.0" },
});

export const RssItemSchema = z.object({
  guid: z.string().optional(),
  link: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  contentSnippet: z.string().optional(),
  isoDate: z.string().optional(),
  categories: z.array(z.string()).optional(),
});

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
}

export const JOB_TYPE_PRESETS = ["Full-time", "Part-time", "Contract", "Freelance", "Internship"];

const JOB_TYPE_MAP: Record<string, string> = {
  full_time: "full-time",
  fulltime: "full-time",
  part_time: "part-time",
  parttime: "part-time",
  contract: "contract",
  contractor: "contract",
  freelance: "freelance",
  internship: "internship",
  intern: "internship",
  temporary: "contract",
};

export function normalizeJobType(raw: string): string | undefined {
  return JOB_TYPE_MAP[raw.toLowerCase().replace(/[\s-]+/g, "_")];
}

// collapse compound words BEFORE abbreviation expansion so "dev ops" -> "devops" is handled first
const COMPOUND_NORMALIZATIONS: readonly [RegExp, string][] = [
  [/\bdev\s*ops\b/gi, "devops"],
  [/\bfull\s*-?\s*stack\b/gi, "fullstack"],
  [/\bfront\s*-?\s*end\b/gi, "frontend"],
  [/\bback\s*-?\s*end\b/gi, "backend"],
];

const TITLE_NORMALIZATIONS: readonly [RegExp, string][] = [
  [/\bsr\.?\b/gi, "senior"],
  [/\bjr\.?\b/gi, "junior"],
  [/\bjnr\b/gi, "junior"],
  [/\bsnr\b/gi, "senior"],
  [/\bdev\b/gi, "developer"],
  [/\beng\b/gi, "engineer"],
  [/\bmgr\b/gi, "manager"],
  [/\bc\+\+\b/gi, "cplusplus"],
  [/\bc#\b/gi, "csharp"],
  [/\.net\b/gi, "dotnet"],
];

const COMPANY_STRIP = /\b(inc|llc|ltd|corp|co|gmbh|ag|plc|s\.?a\.?|b\.?v\.?)\b\.?/gi;

function cleanText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// strip common location/work-mode suffixes that don't distinguish jobs
const TITLE_SUFFIX_RE =
  /\s*[-–|(/]\s*(?:remote|hybrid|onsite|on-site|worldwide|anywhere|work from home|wfh)\s*[)]*\s*$/gi;

export function normalizeForDedup(title: string, company: string): string {
  let t = title.toLowerCase().trim();
  t = t.replace(TITLE_SUFFIX_RE, "");
  for (const [re, rep] of COMPOUND_NORMALIZATIONS) t = t.replace(re, rep);
  for (const [re, rep] of TITLE_NORMALIZATIONS) t = t.replace(re, rep);

  const c = company.replace(COMPANY_STRIP, "").replace(/[-_]/g, " ");

  return `${cleanText(t)}::${cleanText(c)}`;
}

const SEPARATOR_RE = /[,/]|\bor\b|\bили\b|\babo\b/i;

export function parseCommaSeparated(text: string): string[] {
  return text
    .split(SEPARATOR_RE)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function parseCommaSeparatedRaw(text: string): string[] {
  return text
    .split(SEPARATOR_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function stripHtml(html: string): string {
  return decodeHTML(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export async function runWorkerPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const queue = [...items];
  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => drain()));
}
