const NON_USD = /\b(eur|cad|gbp)\b|([£€])/i;
const USD_RE = /[$]|usd/;
const HOURLY_RE = /\/\s*h(?:ou)?r|per\s*hour/i;
const MONTHLY_RE = /\/\s*mo(?:nth)?|per\s*month|\bmonthly\b/i;
const RANGE_K_RE = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*k\b/; // "120k-150k"
const K_RE = /(\d+(?:\.\d+)?)\s*k\b/g; // "120k"
const BIG_NUM_RE = /(?<!\d\.)(\d{4,})/g; // "120000" - 4+ digits, not after decimal
const ANY_NUM_RE = /(\d+(?:\.\d+)?)/g; // fallback for hourly/monthly ("45/hr")
const SPACE_DIGIT_RE = /(\d)\s+(\d)/g; // "25 000" -> "25000" (EUR format)
const DOT_THOUSANDS_RE = /(\d)\.(\d{3})(?!\d)/g; // "4.000" -> "4000" (DE/PL/FR format)

// Nnn-USD rates for salary threshold comparison only
export const TO_USD: Readonly<Record<string, number>> = { eur: 1.08, cad: 0.74, gbp: 1.27 };

function extractNums(s: string, hasHourly: boolean, hasMonthly: boolean): number[] {
  const nums: number[] = [];
  const rangeK = s.match(RANGE_K_RE);
  if (rangeK) {
    nums.push(parseFloat(rangeK[1]!) * 1000, parseFloat(rangeK[2]!) * 1000);
  } else {
    for (const m of s.matchAll(K_RE)) nums.push(parseFloat(m[1]!) * 1000);
    for (const m of s.matchAll(BIG_NUM_RE)) nums.push(parseFloat(m[1]!));
    if (nums.length === 0 && (hasHourly || hasMonthly)) {
      for (const m of s.matchAll(ANY_NUM_RE)) nums.push(parseFloat(m[1]!));
    }
  }
  return nums;
}

const HOURS_PER_YEAR = 2080; // 40h/week * 52 weeks
const MAX_HOURLY_RATE = 500; // above this, assume annual

function computeMultiplier(hasHourly: boolean, hasMonthly: boolean, nums: number[]): number {
  if (hasHourly) return HOURS_PER_YEAR;
  if (hasMonthly) return 12;
  // heuristic fallback no explicit period indicator small numbers -> likely hourly
  if (nums.every((n) => n < MAX_HOURLY_RATE)) return HOURS_PER_YEAR;
  return 1;
}

function parseSalaryRange(s: string): { min: number; max: number } | undefined {
  const hasHourly = HOURLY_RE.test(s);
  const hasMonthly = MONTHLY_RE.test(s);
  const nums = extractNums(s, hasHourly, hasMonthly);
  if (nums.length === 0) return undefined;
  const multiplier = computeMultiplier(hasHourly, hasMonthly, nums);
  return { min: Math.min(...nums) * multiplier, max: Math.max(...nums) * multiplier };
}

function normalizeThousands(s: string): string {
  // DOT_THOUSANDS_RE needs multiple passes for chained groups: "1.200.000" -> "1200.000" -> "1200000"
  let prev = s;
  for (;;) {
    const next = prev.replace(DOT_THOUSANDS_RE, "$1$2");
    if (next === prev) break;
    prev = next;
  }
  return prev.replace(SPACE_DIGIT_RE, "$1$2");
}

export function extractSalaryUsd(
  salary: string | undefined,
): { min: number; max: number } | undefined {
  if (!salary) return undefined;
  const s = salary.toLowerCase().replace(/,/g, "");

  const currencyMatch = s.match(NON_USD);
  if (currencyMatch) {
    const raw = (currencyMatch[1] ?? currencyMatch[2]!).toLowerCase();
    const code = raw === "€" ? "eur" : raw === "£" ? "gbp" : raw;
    const rate = TO_USD[code];
    if (!rate) return undefined;
    const range = parseSalaryRange(normalizeThousands(s));
    if (!range) return undefined;
    return { min: Math.round(range.min * rate), max: Math.round(range.max * rate) };
  }

  if (!USD_RE.test(s)) return undefined;
  return parseSalaryRange(normalizeThousands(s));
}

export function formatSalaryRange(
  min?: number | null,
  max?: number | null,
  currency = "USD",
): string | undefined {
  if (min == null || max == null) return undefined;
  return `${currency} ${min.toLocaleString()} – ${max.toLocaleString()}`;
}
