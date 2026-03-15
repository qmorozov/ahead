import Parser from "rss-parser";
import { HTTP_TIMEOUT } from "./config";

export const rssParser = new Parser({ timeout: HTTP_TIMEOUT });

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const SENIORITY_LEVELS = [
  "Intern",
  "Junior",
  "Middle",
  "Senior",
  "Staff",
  "Lead",
  "Manager",
] as const;

export const SENIORITY_PATTERNS: [string, RegExp][] = [
  ["Intern", /\bintern(?:ship)?\b/i],
  ["Junior", /\b(?:junior|jr\.?|jnr)\b/i],
  ["Middle", /\b(?:middle|mid[- ]?level|mid)\b/i],
  ["Senior", /\b(?:senior|sr\.?|snr)\b/i],
  ["Staff", /\b(?:staff|principal)\b/i],
  ["Lead", /\b(?:lead|team lead)\b/i],
  ["Manager", /\b(?:manager|director|head of|vp\b)/i],
];

export function detectSeniority(title: string): string | null {
  for (const [label, pattern] of SENIORITY_PATTERNS) {
    if (pattern.test(title)) return label;
  }
  return null;
}

const TITLE_NORMALIZATIONS: [RegExp, string][] = [
  [/\bsr\.?\b/gi, "senior"],
  [/\bjr\.?\b/gi, "junior"],
  [/\bjnr\b/gi, "junior"],
  [/\bsnr\b/gi, "senior"],
  [/\bdev\b/gi, "developer"],
  [/\beng\b/gi, "engineer"],
  [/\bmgr\b/gi, "manager"],
];

const COMPANY_STRIP = /\b(inc|llc|ltd|corp|co|gmbh|ag|plc|s\.?a\.?|b\.?v\.?)\b\.?/gi;

export function normalizeForDedup(title: string, company: string): string {
  let t = title.toLowerCase().trim();
  for (const [re, rep] of TITLE_NORMALIZATIONS) t = t.replace(re, rep);
  t = t
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const c = company
    .toLowerCase()
    .trim()
    .replace(COMPANY_STRIP, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${t}::${c}`;
}

export function parseCommaSeparated(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const NON_USD = /\b(eur|gbp|cad|aud|chf|jpy|cny|inr|brl|pln|czk|sek|nok|dkk|£|€|¥)\b/i;

export function extractSalaryUsd(
  salary: string | undefined,
): { min: number; max: number } | undefined {
  if (!salary) return undefined;
  const s = salary.toLowerCase().replace(/,/g, "");
  if (NON_USD.test(s)) return undefined;
  if (!/[$]|usd/.test(s)) return undefined;

  const hasHourlyMarker = /\/\s*h(?:ou)?r|per\s*hour/i.test(s);
  const hasMonthlyMarker = /\/\s*mo(?:nth)?|per\s*month/i.test(s);

  const nums: number[] = [];
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*k\b/g)) nums.push(parseFloat(m[1]!) * 1000);
  for (const m of s.matchAll(/(?<!\d\.)(\d{4,})/g)) nums.push(parseFloat(m[1]!));
  if (nums.length === 0 && (hasHourlyMarker || hasMonthlyMarker)) {
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)/g)) nums.push(parseFloat(m[1]!));
  }

  if (nums.length === 0) return undefined;
  const isHourly = hasHourlyMarker || nums.every((n) => n < 500);
  const multiplier = isHourly ? 2080 : hasMonthlyMarker ? 12 : 1;
  return { min: Math.min(...nums) * multiplier, max: Math.max(...nums) * multiplier };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1))))
    .replace(/\s+/g, " ")
    .trim();
}
