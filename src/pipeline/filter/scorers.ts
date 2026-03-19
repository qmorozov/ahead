import { franc } from "franc-min";
import { Job, ParsedJob } from "../../types";
import { SENIORITY_ORDER, extractSalaryUsd } from "../../lib/utils";
import { SCORING, PENALTY, STACK, FRESHNESS, POLLING, HIGH_QUALITY_SOURCES } from "../../constants";
import { CANONICAL_TO_DOMAINS } from "../../lib/tech-data";
import { testKeyword, matchesAny, normalizeTag, GENERIC_TOOLS } from "./matching";
import { ROLE_CONFIGS, GENERIC_DEV_PATTERN } from "./roles";
import { matchesSeniority, seniorityDetected } from "./seniority";
import type { ScoringContext, JobAnalysis, ScorerResult } from "./index";

const STAFFING_AGENCY_RE =
  /\b(confidential|staffing|recruiting|recruitment|talent\s*(solution|acquisition|partner)|manpower|hays|robert\s*half|adecco|randstad|modis|kforce|tek\s*systems|insight\s*global)\b/i;

// Specialist tech = belongs to 1-3 domains (react→frontend, kotlin→mobile).
// If it's in the title and user doesn't know it, it's a strong mismatch signal.
// Techs in 4+ domains (python, javascript) are too broad to penalize.
const MAX_SPECIALIST_DOMAINS = 3;

function isSpecialistTech(tech: string): boolean {
  const domains = CANONICAL_TO_DOMAINS.get(tech);
  return domains !== undefined && domains.length > 0 && domains.length <= MAX_SPECIALIST_DOMAINS;
}

export function scoreExcludedTech(
  _job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  if (ctx.excludeTagSet.size > 0 && a.hasParsedTags) {
    if (a.parsedTags.some((tag) => ctx.excludeTagSet.has(normalizeTag(tag)))) {
      return { score: 0, signals: ["excluded tech"], hardReject: true };
    }
  }
  return { score: 0, signals: [] };
}

export function scoreSeniority(
  job: Job,
  parsed: ParsedJob | null,
  ctx: ScoringContext,
): ScorerResult {
  const known = ctx.senioritySet.size > 0 && seniorityDetected(job.title, parsed);
  if (!known) return { score: 0, signals: [] };

  if (!matchesSeniority(job.title, parsed, ctx.senioritySet)) {
    return { score: 0, signals: ["seniority mismatch"], hardReject: true };
  }

  let score = SCORING.SENIORITY_MATCH;
  const signals = [parsed?.seniority ?? "level match"];

  if (parsed?.seniority) {
    const userMax = Math.max(...[...ctx.senioritySet].map((s) => SENIORITY_ORDER.indexOf(s)));
    const jobLevel = SENIORITY_ORDER.indexOf(parsed.seniority.toLowerCase());
    if (jobLevel >= 0 && userMax >= 0 && jobLevel - userMax >= 2) {
      score += PENALTY.OVERQUALIFIED;
      signals.push("overqualified");
    }
  }

  return { score, signals };
}

export function scoreTitleKeywords(
  job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
): ScorerResult {
  if (ctx.expandedKeywords.length === 0) return { score: 0, signals: [] };
  if (!matchesAny(job.title, ctx.expandedKeywords)) return { score: 0, signals: [] };

  const matched = ctx.expandedKeywords.filter((kw) => testKeyword(job.title, kw));
  return { score: SCORING.TITLE_KEYWORD, signals: [`${matched.join(", ")} in title`] };
}

export function scoreTagOverlap(
  job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  let score = 0;
  const signals: string[] = [];

  if (
    ctx.expandedKeywords.length > 0 &&
    job.tags.length > 0 &&
    matchesAny(job.tags.join(" "), ctx.expandedKeywords)
  ) {
    score += SCORING.TAG_KEYWORD;
  }

  if (a.effectiveTags.length === 0 || ctx.tagSet.size === 0) return { score, signals };

  const jobNonGeneric = a.effectiveTags.filter((t) => !GENERIC_TOOLS.has(normalizeTag(t)));
  const matchedAll = a.effectiveTags.filter((t) => ctx.tagSet.has(normalizeTag(t)));
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

  if (jobCoverage >= 0.6 && userRecall >= 0.5) {
    score += SCORING.STRONG_STACK_FIT;
  }

  if (jobNonGeneric.length >= 3 && matchedNonGeneric.length === 0 && ctx.userNonGenericCount >= 3) {
    score += PENALTY.OVERQUALIFIED;
    signals.push("no core tech");
  }

  return { score, signals };
}

export function scoreDescriptionKeywords(
  _job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  if (ctx.expandedKeywords.length === 0 || !a.desc) return { score: 0, signals: [] };
  const n = ctx.expandedKeywords.filter((kw) => testKeyword(a.desc, kw)).length;
  return { score: Math.min(n * 3, 15), signals: [] };
}

export function scoreStackMatch(
  job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
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
  const llmHit = a.hasParsedTags && a.parsedTags.some(isNonGenericMatch);
  const descHits = a.desc ? ctx.stackKeywords.filter((kw) => testKeyword(a.desc, kw)).length : 0;
  const inferredHit = a.effectiveTags.length > 0 && a.effectiveTags.some(isNonGenericMatch);

  const hasStrongSignal = titleHit || llmHit || inferredHit;
  if (!hasStrongSignal && tagHits < 2 && descHits < 2) {
    return { score: 0, signals: ["no stack match"], hardReject: true };
  }

  return { score: 0, signals: [] };
}

export function scoreRole(
  job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  if (ctx.roles.length === 0) return { score: 0, signals: [] };

  let score = 0;
  const signals: string[] = [];
  let roleMatched = false;

  const userRoles = new Set(ctx.roles.map((r) => r.toLowerCase()));
  const originalRoles = new Set(userRoles);
  if (userRoles.has("fullstack")) {
    userRoles.add("frontend");
    userRoles.add("backend");
  }
  if (userRoles.has("frontend") || userRoles.has("backend")) userRoles.add("fullstack");

  for (const r of userRoles) {
    if (ROLE_CONFIGS[r]?.titlePattern.test(job.title)) {
      const isExpanded = !originalRoles.has(r) && !originalRoles.has("fullstack");
      score += isExpanded ? Math.round(SCORING.ROLE_MATCH / 2) : SCORING.ROLE_MATCH;
      signals.push(isExpanded ? `~${r}` : r);
      roleMatched = true;
      break;
    }
  }

  if (!roleMatched) {
    // Generic "Software Engineer" titles match any dev role — don't reject
    if (GENERIC_DEV_PATTERN.test(job.title)) {
      score += Math.round(SCORING.ROLE_MATCH / 2);
      signals.push("~software engineer");
      roleMatched = true;
    } else {
      for (const [role, config] of Object.entries(ROLE_CONFIGS)) {
        if (!userRoles.has(role) && config.titlePattern.test(job.title)) {
          return { score: 0, signals: [`wrong role: ${role}`], hardReject: true };
        }
      }
    }
  }

  if (ctx.roleTechSet.size > 0 && a.hasParsedTags) {
    const roleTechHits = a.parsedTags.filter((tag) => {
      const norm = normalizeTag(tag);
      return ctx.roleTechSet.has(norm) && ctx.tagSet.has(norm);
    }).length;
    if (roleTechHits >= 1) {
      score += roleTechHits >= 2 ? 10 : 5;
      roleMatched = true;
    }
  }

  if (!roleMatched) score += PENALTY.NO_ROLE;

  return { score, signals };
}

export function scoreForeignTech(
  _job: Job,
  _parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  if (ctx.tagSet.size === 0 || a.titleTags.length === 0) return { score: 0, signals: [] };

  const foreignPrimary = a.titleTags.filter(
    (t) => isSpecialistTech(t) && !ctx.tagSet.has(normalizeTag(t)),
  );
  if (foreignPrimary.length === 0) return { score: 0, signals: [] };

  return {
    score: PENALTY.FOREIGN_TECH * foreignPrimary.length,
    signals: [`foreign tech: ${foreignPrimary.join(", ")}`],
  };
}

export function scoreFreshness(job: Job): ScorerResult {
  if (!job.publishedAt) return { score: 0, signals: [] };
  const h = (Date.now() - new Date(job.publishedAt).getTime()) / 3_600_000;
  if (h < 0) return { score: 0, signals: [] };
  return {
    score: Math.round(SCORING.FRESHNESS_MAX * Math.exp(-h / FRESHNESS.DECAY_HOURS)),
    signals: [],
  };
}

export function scoreSalary(job: Job, parsed: ParsedJob | null, ctx: ScoringContext): ScorerResult {
  if (ctx.minSalaryUsd <= 0) return { score: 0, signals: [] };

  const sal = extractSalaryUsd(job.salary) ?? extractSalaryUsd(parsed?.salary ?? undefined);
  const max = sal?.max ?? job.salaryMinUsd;
  if (max !== undefined && max >= ctx.minSalaryUsd) {
    return { score: SCORING.SALARY_MATCH, signals: [`$${Math.round(max / 1000)}k+`] };
  }
  return { score: 0, signals: [] };
}

export function scoreExcludeKeywords(
  _job: Job,
  parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  if (ctx.expandedExcludes.length === 0) return { score: 0, signals: [] };

  let score = 0;
  if (parsed) {
    if (parsed.requirements.some((r) => matchesAny(r, ctx.expandedExcludes)))
      score += PENALTY.EXCLUDE_REQUIREMENT;
    if (parsed.niceToHave.some((r) => matchesAny(r, ctx.expandedExcludes)))
      score += PENALTY.EXCLUDE_NICE;
  }
  if (a.desc && matchesAny(a.desc, ctx.expandedExcludes)) score += PENALTY.EXCLUDE_DESC;

  return { score, signals: [] };
}

export function scoreJobQuality(
  job: Job,
  parsed: ParsedJob | null,
  ctx: ScoringContext,
  a: JobAnalysis,
): ScorerResult {
  let score = 0;
  const signals: string[] = [];

  if (a.desc.length >= 50 && !a.hasParsedTags) {
    const lang = franc(a.desc, { minLength: 50 });
    if (lang !== "und" && lang !== "eng") {
      score += PENALTY.FOREIGN_LANGUAGE;
      signals.push(`lang:${lang}`);
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

  const relocateRe = /(must|required to|willing to|open to)\s+relocat/i;
  if (a.desc && relocateRe.test(a.desc)) {
    score += PENALTY.RELOCATION;
    signals.push("relocation required");
  }

  if (
    parsed?.workArrangement === "onsite" &&
    ctx.workArrangement.some((w) => w.toLowerCase() === "remote")
  ) {
    score += PENALTY.ARRANGEMENT_MISMATCH;
    signals.push("onsite only");
  }

  return { score, signals };
}
