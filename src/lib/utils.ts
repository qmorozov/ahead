import Parser from "rss-parser";
import { decodeHTML } from "entities";
import { HTTP_TIMEOUT } from "../config";

export const rssParser = new Parser({ timeout: HTTP_TIMEOUT });

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
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
  ["Middle", /\b(?:middle|mid[- ]?level)\b/i],
  ["Senior", /\b(?:senior|sr\.?|snr)\b/i],
  ["Staff", /\b(?:staff|principal)\b/i],
  ["Lead", /\b(?:lead|team lead)\b/i],
  ["Manager", /\b(?:manager|director|head of|vp\b)/i],
];

export const JOB_TYPE_PRESETS = ["Full-time", "Part-time", "Contract", "Freelance", "Internship"];

const JOB_TYPE_MAP: Record<string, string> = {
  full_time: "full-time",
  "full-time": "full-time",
  fulltime: "full-time",
  part_time: "part-time",
  "part-time": "part-time",
  parttime: "part-time",
  contract: "contract",
  contractor: "contract",
  freelance: "freelance",
  internship: "internship",
  intern: "internship",
};

export function normalizeJobType(raw: string): string | undefined {
  return JOB_TYPE_MAP[raw.toLowerCase().replace(/[\s-]+/g, "_")] ?? JOB_TYPE_MAP[raw.toLowerCase()];
}

export const SENIORITY_ORDER = SENIORITY_LEVELS.map((s) => s.toLowerCase());

const SENIORITY_ALIASES: Record<string, string> = {
  "mid-level": "Middle",
  midlevel: "Middle",
  "mid level": "Middle",
  intermediate: "Middle",
  medior: "Middle",
  "semi-senior": "Middle",
  "entry level": "Junior",
  "entry-level": "Junior",
  associate: "Junior",
  "new grad": "Junior",
  graduate: "Junior",
  trainee: "Intern",
  "co-op": "Intern",
  "sde i": "Junior",
  "software engineer i": "Junior",
  "sde ii": "Middle",
  "software engineer ii": "Middle",
  "sde iii": "Senior",
  "software engineer iii": "Senior",
  principal: "Staff",
  sr: "Senior",
  "sr.": "Senior",
};

export function normalizeSeniority(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (SENIORITY_ALIASES[lower]) return SENIORITY_ALIASES[lower]!;
  const idx = SENIORITY_ORDER.indexOf(lower);
  return idx >= 0 ? SENIORITY_LEVELS[idx]! : null;
}

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
  [/\bc\+\+\b/gi, "cplusplus"],
  [/\bc#\b/gi, "csharp"],
  [/\.net\b/gi, "dotnet"],
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
    .replace(/[-_]/g, " ")
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

export function parseCommaSeparatedRaw(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const NON_USD = /\b(eur|gbp|cad|aud|chf|jpy|cny|inr|brl|pln|czk|sek|nok|dkk|£|€|¥)\b/i;

const TO_USD: Record<string, number> = {
  eur: 1.08, gbp: 1.27, pln: 0.25, cad: 0.74, chf: 1.12,
};
const CURRENCY_SYMBOLS: Record<string, string> = { "€": "eur", "£": "gbp" };

export function extractSalaryUsd(
  salary: string | undefined,
): { min: number; max: number } | undefined {
  if (!salary) return undefined;
  const s = salary.toLowerCase().replace(/,/g, "");

  // Handle non-USD currencies with approximate conversion
  const currencyMatch = s.match(NON_USD);
  if (currencyMatch) {
    const raw = currencyMatch[1]!.toLowerCase();
    const code = CURRENCY_SYMBOLS[raw] ?? raw;
    const rate = TO_USD[code];
    if (!rate) return undefined;

    const ns = s.replace(/(\d)\s+(\d)/g, "$1$2");
    const hasHourly = /\/\s*h(?:ou)?r|per\s*hour/i.test(ns);
    const hasMonthly = /\/\s*mo(?:nth)?|per\s*month/i.test(ns);

    const nums: number[] = [];
    const rangeK = ns.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*k\b/);
    if (rangeK) {
      nums.push(parseFloat(rangeK[1]!) * 1000, parseFloat(rangeK[2]!) * 1000);
    } else {
      for (const m of ns.matchAll(/(\d+(?:\.\d+)?)\s*k\b/g)) nums.push(parseFloat(m[1]!) * 1000);
      for (const m of ns.matchAll(/(?<!\d\.)(\d{4,})/g)) nums.push(parseFloat(m[1]!));
      if (nums.length === 0 && (hasHourly || hasMonthly)) {
        for (const m of ns.matchAll(/(\d+(?:\.\d+)?)/g)) nums.push(parseFloat(m[1]!));
      }
    }

    if (nums.length === 0) return undefined;
    const isHourly = hasHourly || nums.every((n) => n < 500);

    let multiplier = 1;
    if (isHourly) multiplier = 2080;
    else if (hasMonthly) multiplier = 12;

    return {
      min: Math.round(Math.min(...nums) * multiplier * rate),
      max: Math.round(Math.max(...nums) * multiplier * rate),
    };
  }

  // Existing USD logic (unchanged)
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

  let multiplier = 1;
  if (isHourly) multiplier = 2080;
  else if (hasMonthlyMarker) multiplier = 12;

  return { min: Math.min(...nums) * multiplier, max: Math.max(...nums) * multiplier };
}

export function stripHtml(html: string): string {
  return decodeHTML(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function formatSalaryRange(
  min?: number | null,
  max?: number | null,
  currency = "USD",
): string | undefined {
  if (min == null || max == null) return undefined;
  return `${currency} ${min.toLocaleString()} – ${max.toLocaleString()}`;
}
