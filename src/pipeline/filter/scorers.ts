import { franc } from "franc-min";
import { SENIORITY_ORDER } from "../../lib/seniority";
import { extractSalaryUsd } from "../../lib/salary";
import { SCORING, PENALTY, STACK, FRESHNESS, POLLING, HIGH_QUALITY_SOURCES, FEEDBACK } from "../../constants";
import { CANONICAL_TO_DOMAINS, ALL_KNOWN_TECHS } from "../../lib/tech-data";
import { testKeyword, matchesAny, normalizeTag, GENERIC_TOOLS } from "./matching";
import { ROLE_CONFIGS, GENERIC_DEV_PATTERN } from "./roles";
import { matchesSeniority, seniorityDetected } from "./seniority";
import type { ScorerInput, ScorerResult } from "./index";

// franc returns ISO 639-3 codes; map user-facing language names to those codes
const LANG_TO_FRANC: Readonly<Record<string, string>> = {
  english: "eng",
  chinese: "cmn",
  spanish: "spa",
  german: "deu",
  french: "fra",
  portuguese: "por",
  japanese: "jpn",
  korean: "kor",
  dutch: "nld",
  italian: "ita",
  polish: "pol",
  russian: "rus",
  ukrainian: "ukr",
  turkish: "tur",
  arabic: "arb",
};

// tech-heavy text has no useful language signal for franc
function isTechHeavy(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[\s,|·•–—/()[\]{}]+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const techWords = words.filter((w) => ALL_KNOWN_TECHS.has(w) || GENERIC_TOOLS.has(w));
  return techWords.length / words.length > 0.6;
}

const STAFFING_AGENCY_RE =
  /\b(confidential|staffing|recruiting|recruitment|talent\s*(solution|acquisition|partner)|manpower|hays|robert\s*half|adecco|randstad|modis|kforce|tek\s*systems|insight\s*global)\b/i;

const RELOCATE_RE = /(must|required to|willing to|open to)\s+relocat/i;

// Specialist tech = belongs to 1-3 domains (react→frontend, kotlin→mobile).
// If it's in the title and user doesn't know it, it's a strong mismatch signal.
// Techs in 4+ domains (python, javascript) are too broad to penalize.
const MAX_SPECIALIST_DOMAINS = 3;

function isSpecialistTech(tech: string): boolean {
  const domains = CANONICAL_TO_DOMAINS.get(tech);
  return domains !== undefined && domains.length > 0 && domains.length <= MAX_SPECIALIST_DOMAINS;
}

export function scoreExcludedTech({ ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.excludeTagSet.size > 0 && analysis.hasParsedTags) {
    if (analysis.parsedTags.some((tag) => ctx.excludeTagSet.has(normalizeTag(tag)))) {
      return { score: 0, signals: ["excluded tech"], hardReject: true };
    }
  }
  return { score: 0, signals: [] };
}

export function scoreSeniority({ job, parsed, ctx }: ScorerInput): ScorerResult {
  const known = ctx.senioritySet.size > 0 && seniorityDetected(job.title, parsed);
  if (!known) return { score: 0, signals: [] };

  if (!matchesSeniority(job.title, parsed, ctx.senioritySet)) {
    return { score: 0, signals: ["seniority mismatch"], hardReject: true };
  }

  let score = SCORING.SENIORITY_MATCH;
  const signals = [parsed?.seniority ?? "level match"];

  if (parsed?.seniority) {
    const indices = [...ctx.senioritySet].map((s) => SENIORITY_ORDER.indexOf(s));
    const userMax = indices.length > 0 ? Math.max(...indices) : -1;
    const jobLevel = SENIORITY_ORDER.indexOf(parsed.seniority.toLowerCase());
    if (jobLevel >= 0 && userMax >= 0 && jobLevel - userMax >= 2) {
      score += PENALTY.OVERQUALIFIED;
      signals.push("overqualified");
    }
  }

  return { score, signals };
}

export function scoreTitleKeywords({ job, ctx }: ScorerInput): ScorerResult {
  if (ctx.stackKeywords.length === 0) return { score: 0, signals: [] };
  if (!matchesAny(job.title, ctx.stackKeywords)) return { score: 0, signals: [] };

  const matched = ctx.stackKeywords.filter((kw) => testKeyword(job.title, kw));
  return { score: SCORING.TITLE_KEYWORD, signals: [`${matched.join(", ")} in title`] };
}

export function scoreTagOverlap({ job, ctx, analysis }: ScorerInput): ScorerResult {
  let score = 0;
  const signals: string[] = [];

  if (
    ctx.expandedKeywords.length > 0 &&
    job.tags.length > 0 &&
    matchesAny(job.tags.join(" "), ctx.expandedKeywords)
  ) {
    score += SCORING.TAG_KEYWORD;
  }

  if (analysis.effectiveTags.length === 0 || ctx.tagSet.size === 0) return { score, signals };

  const jobNonGeneric = analysis.effectiveTags.filter((t) => !GENERIC_TOOLS.has(normalizeTag(t)));
  const matchedAll = analysis.effectiveTags.filter((t) => ctx.tagSet.has(normalizeTag(t)));
  const matchedNonGeneric = jobNonGeneric.filter((t) => ctx.tagSet.has(normalizeTag(t)));

  const jobCoverage =
    jobNonGeneric.length > 0 ? matchedNonGeneric.length / jobNonGeneric.length : 0;
  const userRecall =
    ctx.userNonGenericCount > 0 ? matchedNonGeneric.length / ctx.userNonGenericCount : 0;

  if (
    jobNonGeneric.length >= STACK.MIN_TAGS &&
    ctx.userNonGenericCount >= STACK.MIN_TAGS &&
    jobCoverage < STACK.COVERAGE_THRESHOLD &&
    userRecall < STACK.RECALL_THRESHOLD
  ) {
    return {
      score: 0,
      signals: [`stack mismatch (${matchedNonGeneric.length}/${jobNonGeneric.length})`],
      hardReject: true,
    };
  }

  const overlapScore = Math.round(
    SCORING.TAG_OVERLAP_MAX *
      Math.min(1, jobCoverage * STACK.COVERAGE_WEIGHT + userRecall * STACK.RECALL_WEIGHT),
  );
  score += overlapScore;
  if (matchedAll.length > 0) {
    signals.push(`${matchedAll.join(", ")} tags (${Math.round(jobCoverage * 100)}%)`);
  }

  if (jobCoverage >= STACK.STRONG_COVERAGE && userRecall >= STACK.STRONG_RECALL) {
    score += SCORING.STRONG_STACK_FIT;
  }

  if (jobNonGeneric.length >= 3 && matchedNonGeneric.length === 0 && ctx.userNonGenericCount >= 3) {
    score += PENALTY.OVERQUALIFIED;
    signals.push("no core tech");
  }

  return { score, signals };
}

export function scoreDescriptionKeywords({ ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.expandedKeywords.length === 0 || !analysis.desc) return { score: 0, signals: [] };
  const n = ctx.expandedKeywords.filter((kw) => testKeyword(analysis.desc, kw)).length;
  return { score: Math.min(n * 3, SCORING.DESC_KEYWORD_MAX), signals: [] };
}

export function scoreStackMatch({ job, ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.stackKeywords.length === 0) return { score: 0, signals: [] };

  const isNonGenericMatch = (t: string) => {
    const norm = normalizeTag(t);
    return ctx.tagSet.has(norm) && !GENERIC_TOOLS.has(norm);
  };

  const titleHit = matchesAny(job.title, ctx.stackKeywords);
  const tagHits =
    job.tags.length > 0
      ? ctx.stackKeywords.filter((kw) => testKeyword(job.tags.join(" "), kw)).length
      : 0;
  const llmHit = analysis.hasParsedTags && analysis.parsedTags.some(isNonGenericMatch);
  const descHits = analysis.desc
    ? ctx.stackKeywords.filter((kw) => testKeyword(analysis.desc, kw)).length
    : 0;
  const inferredHit =
    analysis.effectiveTags.length > 0 && analysis.effectiveTags.some(isNonGenericMatch);

  const hasStrongSignal = titleHit || llmHit || inferredHit;
  if (!hasStrongSignal && tagHits < 2 && descHits < 2) {
    return { score: 0, signals: ["no stack match"], hardReject: true };
  }

  return { score: 0, signals: [] };
}

function expandRoles(roles: string[]): { expanded: Set<string>; original: Set<string> } {
  const original = new Set(roles.map((r) => r.toLowerCase()));
  const expanded = new Set(original);
  if (expanded.has("fullstack")) {
    expanded.add("frontend");
    expanded.add("backend");
  }
  if (expanded.has("frontend") || expanded.has("backend")) expanded.add("fullstack");
  return { expanded, original };
}

function matchTitleRole(
  title: string,
  expanded: Set<string>,
  original: Set<string>,
): { score: number; signal: string } | null {
  for (const r of expanded) {
    if (ROLE_CONFIGS[r]?.titlePattern.test(title)) {
      const isImplied = !original.has(r) && !original.has("fullstack");
      const isFullstackMatch = r === "fullstack" && !original.has("fullstack");
      return {
        score: isImplied && !isFullstackMatch ? Math.round(SCORING.ROLE_MATCH / 2) : SCORING.ROLE_MATCH,
        signal: isImplied ? `~${r}` : r,
      };
    }
  }
  return null;
}

function detectWrongRole(title: string, userRoles: Set<string>): ScorerResult | null {
  for (const [role, config] of Object.entries(ROLE_CONFIGS)) {
    if (!userRoles.has(role) && config.titlePattern.test(title)) {
      return { score: 0, signals: [`wrong role: ${role}`], hardReject: true };
    }
  }
  return null;
}

export function scoreRole({ job, ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.roles.length === 0) return { score: 0, signals: [] };

  const { expanded, original } = expandRoles(ctx.roles);
  let score = 0;
  const signals: string[] = [];
  let roleMatched = false;

  const titleMatch = matchTitleRole(job.title, expanded, original);
  if (titleMatch) {
    score += titleMatch.score;
    signals.push(titleMatch.signal);
    roleMatched = true;
  }

  if (!roleMatched) {
    if (GENERIC_DEV_PATTERN.test(job.title)) {
      score += Math.round(SCORING.ROLE_MATCH / 2);
      signals.push("~software engineer");
      roleMatched = true;
    } else {
      const wrongRole = detectWrongRole(job.title, expanded);
      if (wrongRole) return wrongRole;
    }
  }

  if (ctx.roleTechSet.size > 0 && analysis.hasParsedTags) {
    const roleTechHits = analysis.parsedTags.filter((tag) => {
      const norm = normalizeTag(tag);
      return ctx.roleTechSet.has(norm) && ctx.tagSet.has(norm);
    }).length;
    if (roleTechHits >= 1) {
      score += roleTechHits >= 2 ? SCORING.ROLE_TECH_MAX : Math.round(SCORING.ROLE_TECH_MAX / 2);
      roleMatched = true;
    }
  }

  if (!roleMatched) score += PENALTY.NO_ROLE;

  return { score, signals };
}

export function scoreForeignTech({ ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.tagSet.size === 0) return { score: 0, signals: [] };

  const seen = new Set<string>();
  const foreign: string[] = [];

  for (const t of [...analysis.titleTags, ...analysis.parsedTags]) {
    const norm = normalizeTag(t);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (isSpecialistTech(t) && !ctx.tagSet.has(norm)) foreign.push(t);
  }

  if (foreign.length === 0) return { score: 0, signals: [] };

  return {
    score: PENALTY.FOREIGN_TECH * foreign.length,
    signals: [`foreign tech: ${foreign.join(", ")}`],
  };
}

export function scoreFreshness({ job }: ScorerInput): ScorerResult {
  if (!job.publishedAt) return { score: 0, signals: [] };
  const postedMs = new Date(job.publishedAt).getTime();
  if (isNaN(postedMs)) return { score: 0, signals: [] };
  const h = (Date.now() - postedMs) / 3_600_000;
  if (h < 0) return { score: 0, signals: [] };
  return {
    score: Math.round(SCORING.FRESHNESS_MAX * Math.exp(-h / FRESHNESS.DECAY_HOURS)),
    signals: [],
  };
}

export function scoreSalary({ job, parsed, ctx }: ScorerInput): ScorerResult {
  if (ctx.minSalaryUsd <= 0) return { score: 0, signals: [] };

  const sal = extractSalaryUsd(job.salary) ?? extractSalaryUsd(parsed?.salary ?? undefined);
  const max = sal?.max ?? job.salaryMinUsd;
  if (max !== undefined && max >= ctx.minSalaryUsd) {
    return { score: SCORING.SALARY_MATCH, signals: [`$${Math.round(max / 1000)}k+`] };
  }
  return { score: 0, signals: [] };
}

export function scoreExcludeKeywords({ parsed, ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.expandedExcludes.length === 0) return { score: 0, signals: [] };

  let score = 0;
  if (parsed) {
    if (parsed.requirements.some((r) => matchesAny(r, ctx.expandedExcludes)))
      score += PENALTY.EXCLUDE_REQUIREMENT;
    if (parsed.niceToHave.some((r) => matchesAny(r, ctx.expandedExcludes)))
      score += PENALTY.EXCLUDE_NICE;
  }
  if (analysis.desc && matchesAny(analysis.desc, ctx.expandedExcludes))
    score += PENALTY.EXCLUDE_DESC;

  return { score, signals: [] };
}

export function scoreJobQuality({ job, parsed, ctx, analysis }: ScorerInput): ScorerResult {
  let score = 0;
  const signals: string[] = [];

  if (analysis.desc.length >= 50 && !analysis.hasParsedTags && !isTechHeavy(analysis.desc)) {
    const lang = franc(analysis.desc, { minLength: 50 });
    if (lang !== "und") {
      const acceptedCodes = new Set(
        [...ctx.acceptedLanguages].map((l) => LANG_TO_FRANC[l] ?? l).filter(Boolean),
      );
      if (!acceptedCodes.has(lang)) {
        score += PENALTY.FOREIGN_LANGUAGE;
        signals.push(`lang:${lang}`);
      }
    }
  }

  const missingFields = [job.company, job.description, job.location].filter((f) => !f).length;
  if (missingFields >= 2) {
    score += PENALTY.LOW_QUALITY;
    signals.push("low quality");
  }

  if (HIGH_QUALITY_SOURCES.has(job.source)) score += SCORING.HIGH_QUALITY_SOURCE;

  if (job.company && STAFFING_AGENCY_RE.test(job.company)) {
    score += PENALTY.STAFFING_AGENCY;
    signals.push("staffing agency");
  }

  if (job.boardJobCount && job.boardJobCount >= POLLING.COMPANY_SIZE_MIN_JOBS)
    score += SCORING.COMPANY_SIZE;

  if (analysis.desc && RELOCATE_RE.test(analysis.desc)) {
    score += PENALTY.RELOCATION;
    signals.push("relocation required");
  }

  if (
    parsed?.workArrangement === "onsite" &&
    ctx.workArrangement.some((w) => w.toLowerCase() === "remote") &&
    !ctx.workArrangement.some((w) => w.toLowerCase() === "onsite")
  ) {
    return { score: 0, signals: ["onsite only"], hardReject: true };
  }

  if (
    parsed?.locationRestriction &&
    ctx.expandedLocations.length > 0 &&
    !matchesAny(parsed.locationRestriction, ctx.expandedLocations)
  ) {
    return { score: 0, signals: [`region: ${parsed.locationRestriction}`], hardReject: true };
  }

  return { score, signals };
}

export function scoreFeedback({ ctx, analysis }: ScorerInput): ScorerResult {
  if (ctx.avoidedTags.size === 0 && ctx.preferredTags.size === 0) return { score: 0, signals: [] };

  let score = 0;
  const signals: string[] = [];
  const tags = analysis.hasParsedTags ? analysis.parsedTags : analysis.titleTags;

  for (const t of tags) {
    const norm = normalizeTag(t);
    if (ctx.avoidedTags.has(norm)) score += FEEDBACK.AVOID_PENALTY;
    if (ctx.preferredTags.has(norm)) score += FEEDBACK.PREFER_BONUS;
  }

  if (score < 0) signals.push("avoided by feedback");
  if (score > 0) signals.push("preferred by feedback");
  return { score, signals };
}
