const NON_USD = /\b(eur|cad|€)\b/i;
const USD_RE = /[$]|usd/;
const HOURLY_RE = /\/\s*h(?:ou)?r|per\s*hour/i;
const MONTHLY_RE = /\/\s*mo(?:nth)?|per\s*month/i;
const RANGE_K_RE = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*k\b/; // "120k-150k"
const K_RE = /(\d+(?:\.\d+)?)\s*k\b/g; // "120k"
const BIG_NUM_RE = /(?<!\d\.)(\d{4,})/g; // "120000" - 4+ digits, not after decimal
const ANY_NUM_RE = /(\d+(?:\.\d+)?)/g; // fallback for hourly/monthly ("45/hr")
const SPACE_DIGIT_RE = /(\d)\s+(\d)/g; // "25 000" -> "25000" (EUR format)

// Only convert stable major currencies; other currencies (GBP, PLN, UAH, etc.)
// are shown to the user as-is but don't participate in salary threshold filtering
export const TO_USD: Readonly<Record<string, number>> = { eur: 1.08, cad: 0.74 };

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
  const isHourly = hasHourly || nums.every((n) => n < MAX_HOURLY_RATE);
  if (isHourly) return HOURS_PER_YEAR;
  if (hasMonthly) return 12;
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

/**
 * Extract a salary range in USD from a free-text salary string
 * Handles multi-currency conversion, hourly/monthly rates, and k-suffixes
 *
 * @param salary  Raw salary text (e.g. "$120k-150k", "EUR 60,000-80,000/year")
 * @returns Min/max in USD, or undefined if unparseable or non-USD without known conversion
 */
export function extractSalaryUsd(
  salary: string | undefined,
): { min: number; max: number } | undefined {
  if (!salary) return undefined;
  const s = salary.toLowerCase().replace(/,/g, "");

  const currencyMatch = s.match(NON_USD);
  if (currencyMatch) {
    const raw = currencyMatch[1]!.toLowerCase();
    const code = raw === "€" ? "eur" : raw;
    const rate = TO_USD[code];
    if (!rate) return undefined;
    const result = parseSalaryRange(s.replace(SPACE_DIGIT_RE, "$1$2"));
    if (!result) return undefined;
    return { min: Math.round(result.min * rate), max: Math.round(result.max * rate) };
  }

  if (!USD_RE.test(s)) return undefined;
  return parseSalaryRange(s);
}

/** Format min/max into a display string like "USD 60,000 – 80,000". */
export function formatSalaryRange(
  min?: number | null,
  max?: number | null,
  currency = "USD",
): string | undefined {
  if (min == null || max == null) return undefined;
  return `${currency} ${min.toLocaleString()} – ${max.toLocaleString()}`;
}
