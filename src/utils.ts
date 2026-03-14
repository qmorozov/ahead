import Parser from "rss-parser";

export const rssParser = new Parser({ timeout: 15_000 });

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const SENIORITY_LEVELS = ["Intern", "Junior", "Middle", "Senior", "Staff", "Lead", "Manager"] as const;

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

export function formatSalaryRange(
  min?: number | null,
  max?: number | null,
  currency = "USD",
): string | undefined {
  if (!min || !max) return undefined;
  return `${currency} ${min.toLocaleString()} – ${max.toLocaleString()}`;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
