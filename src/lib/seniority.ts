export const SENIORITY_LEVELS = [
  "Intern",
  "Junior",
  "Middle",
  "Senior",
  "Staff",
  "Lead",
  "Manager",
] as const;

export const SENIORITY_PATTERNS: readonly [string, RegExp][] = [
  ["Intern", /\bintern(?:ship)?\b/i],
  ["Junior", /\b(?:junior|jr\.?|jnr)\b/i],
  ["Middle", /\b(?:middle|mid[- ]?level)\b/i],
  ["Senior", /\b(?:senior|sr\.?|snr)\b/i],
  ["Staff", /\b(?:staff|principal)\b/i],
  ["Lead", /\b(?:lead|team lead)\b/i],
  ["Manager", /\b(?:manager|director|head of|vp\b)/i],
];

export const SENIORITY_ORDER: readonly string[] = SENIORITY_LEVELS.map((s) => s.toLowerCase());

const SENIORITY_ALIASES: Readonly<Record<string, string>> = {
  "mid-level": "Middle",
  midlevel: "Middle",
  "mid level": "Middle",
  intermediate: "Middle",
  medior: "Middle",
  "semi-senior": "Middle",
  "entry level": "Junior",
  "entry-level": "Junior",
  entry_level: "Junior",
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
  mid_senior_level: "Middle",
  principal: "Staff",
  executive: "Manager",
  director: "Lead",
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
