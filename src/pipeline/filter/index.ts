import { UserSettings } from "../../db";
import { Job, ParsedJob } from "../../types";
import { extractSalaryUsd } from "../../lib/salary";
import { SCORING } from "../../constants";
import { expandWithAliases, buildTagSet, normalizeTag, matchesAny, searchableText, inferTagsFromTitle, getStrippedDescription, GENERIC_TOOLS } from "./matching";
import { getRoleTerms, getRoleTechSet } from "./roles";
import { expandLocations, passesLocationCheck } from "./location";
import {
  scoreExcludedTech, scoreSeniority, scoreTitleKeywords, scoreTagOverlap,
  scoreDescriptionKeywords, scoreStackMatch, scoreRole, scoreForeignTech,
  scoreFreshness, scoreSalary, scoreExcludeKeywords, scoreJobQuality,
} from "./scorers";

/** Scoring context derived from user settings. Cached per chatId. */
export interface ScoringContext {
  expandedKeywords: string[];
  stackKeywords: string[];
  expandedExcludes: string[];
  tagSet: Set<string>;
  excludeTagSet: Set<string>;
  senioritySet: Set<string>;
  roleTechSet: Set<string>;
  roles: string[];
  minSalaryUsd: number;
  userNonGenericCount: number;
  workArrangement: string[];
  expandedLocations: string[];
  acceptedLanguages: Set<string>;
}

export interface ScorerResult {
  score: number;
  signals: string[];
  hardReject?: boolean;
}

export interface JobAnalysis {
  desc: string;
  titleTags: string[];
  effectiveTags: string[];
  parsedTags: string[];
  hasParsedTags: boolean;
}

export type ScorerName =
  | "excludedTech"
  | "seniority"
  | "titleKeywords"
  | "tagOverlap"
  | "descKeywords"
  | "stackMatch"
  | "role"
  | "foreignTech"
  | "freshness"
  | "salary"
  | "excludeKeywords"
  | "jobQuality";

export interface ScoreResult {
  score: number;
  normalized: number;
  signals: string[];
  breakdown: Partial<Record<ScorerName, number>>;
}

export interface ScorerInput {
  job: Job;
  parsed: ParsedJob | null;
  ctx: ScoringContext;
  analysis: JobAnalysis;
}

type Scorer = (input: ScorerInput) => ScorerResult;

function extractCoreStack(keywords: string[], roleTechs: Set<string>): string[] {
  const stack = keywords.filter((kw) => {
    const lower = kw.toLowerCase();
    if (roleTechs.has(normalizeTag(lower))) return true;
    return !GENERIC_TOOLS.has(lower);
  });
  return expandWithAliases(stack);
}

const ctxCache = new Map<string, { hash: string; ctx: ScoringContext }>();

function settingsHash(settings: UserSettings): string {
  return [
    settings.keywords.join(","),
    settings.roles.join(","),
    settings.excludeKeywords.join(","),
    settings.seniority.join(","),
    settings.locations.join(","),
    settings.workArrangement.join(","),
    settings.acceptedLanguages.join(","),
    String(settings.minSalaryUsd),
  ].join("|");
}

export function buildScoringContext(settings: UserSettings): ScoringContext {
  const hash = settingsHash(settings);
  const cached = ctxCache.get(settings.chatId);
  if (cached && cached.hash === hash) return cached.ctx;
  const roleTerms = getRoleTerms(settings.roles);
  const roleTechSet = getRoleTechSet(settings.roles);
  const ctx: ScoringContext = {
    expandedKeywords: expandWithAliases([...settings.keywords, ...roleTerms]),
    stackKeywords: extractCoreStack(settings.keywords, roleTechSet),
    expandedExcludes: expandWithAliases(settings.excludeKeywords),
    tagSet: buildTagSet(settings.keywords),
    excludeTagSet: buildTagSet(settings.excludeKeywords),
    senioritySet: new Set(settings.seniority.map((s) => s.toLowerCase())),
    roleTechSet,
    roles: settings.roles,
    minSalaryUsd: settings.minSalaryUsd,
    userNonGenericCount: settings.keywords.filter((kw) => !GENERIC_TOOLS.has(normalizeTag(kw))).length,
    workArrangement: settings.workArrangement,
    expandedLocations: expandLocations(settings.locations),
    acceptedLanguages: new Set(settings.acceptedLanguages.map((l) => l.toLowerCase())),
  };
  ctxCache.set(settings.chatId, { hash, ctx });
  return ctx;
}

export function clearCachedContext(chatId: string): void {
  ctxCache.delete(chatId);
}

function analyzeJob(job: Job, parsed: ParsedJob | null): JobAnalysis {
  const parsedTags = parsed?.primaryTags ?? [];
  const hasParsedTags = parsedTags.length > 0;
  const titleTags = inferTagsFromTitle(job.title);
  const effectiveTags = hasParsedTags
    ? [...new Set([...parsedTags, ...titleTags])]
    : titleTags;
  const desc = job.description ? getStrippedDescription(job) : "";
  return { desc, titleTags, effectiveTags, parsedTags, hasParsedTags };
}

const SCORE_MAX =
  SCORING.TITLE_KEYWORD + SCORING.TAG_KEYWORD + SCORING.TAG_OVERLAP_MAX +
  SCORING.STRONG_STACK_FIT + SCORING.DESC_KEYWORD_MAX +
  SCORING.ROLE_MATCH + SCORING.ROLE_TECH_MAX +
  SCORING.SENIORITY_MATCH + SCORING.FRESHNESS_MAX + SCORING.SALARY_MATCH +
  SCORING.HIGH_QUALITY_SOURCE + SCORING.COMPANY_SIZE;

const scorers: Array<[ScorerName, Scorer]> = [
  ["excludedTech", scoreExcludedTech],
  ["seniority", scoreSeniority],
  ["titleKeywords", scoreTitleKeywords],
  ["tagOverlap", scoreTagOverlap],
  ["descKeywords", scoreDescriptionKeywords],
  ["stackMatch", scoreStackMatch],
  ["role", scoreRole],
  ["foreignTech", scoreForeignTech],
  ["freshness", scoreFreshness],
  ["salary", scoreSalary],
  ["excludeKeywords", scoreExcludeKeywords],
  ["jobQuality", scoreJobQuality],
];

export function computeThreshold(ctx: ScoringContext): number {
  let t = SCORING.THRESHOLD; // base: 20
  if (ctx.expandedKeywords.length > 10) t += 5;
  if (ctx.roles.length > 0) t += 3;
  if (ctx.senioritySet.size > 0) t += 2;
  return t;
}

export function scoreJob(job: Job, parsed: ParsedJob | null, ctx: ScoringContext): ScoreResult {
  const analysis = analyzeJob(job, parsed);
  const breakdown: Partial<Record<ScorerName, number>> = {};
  const signals: string[] = [];
  let total = 0;

  for (const [name, scorer] of scorers) {
    const r = scorer({ job, parsed, ctx, analysis });
    if (r.hardReject) {
      return { score: -1, normalized: 0, signals: r.signals, breakdown: { [name]: -1 } };
    }
    breakdown[name] = r.score;
    total += r.score;
    signals.push(...r.signals);
  }

  const normalized = Math.round(Math.max(0, total) / SCORE_MAX * 100);
  return { score: total, normalized, signals, breakdown };
}

export function filterJobs(jobs: Job[], settings: UserSettings, ctx: ScoringContext): Job[] {
  const { expandedKeywords: searchKeywords, expandedExcludes: excludeKeywords, expandedLocations: locations } = ctx;

  return jobs.filter((job) => {
    const hasExtraContent = job.tags.length > 0 || Boolean(job.description);
    const corpus = hasExtraContent ? searchableText(job) : job.title;
    if (searchKeywords.length > 0 && !matchesAny(corpus, searchKeywords)) return false;

    const header = job.title + " " + job.tags.join(" ");
    if (excludeKeywords.length > 0 && matchesAny(header, excludeKeywords)) return false;

    if (locations.length > 0 && job.location) {
      if (!passesLocationCheck(job.location, locations)) return false;
    }

    if (settings.minSalaryUsd > 0) {
      const max = job.salaryMinUsd ?? extractSalaryUsd(job.salary)?.max;
      if (max !== undefined && max < settings.minSalaryUsd) return false;
    }

    if (settings.jobTypes.length > 0 && job.jobType && !settings.jobTypes.includes(job.jobType)) return false;

    if (settings.maxJobAgeDays > 0 && job.publishedAt) {
      const cutoff = Date.now() - settings.maxJobAgeDays * 24 * 60 * 60 * 1000;
      if (new Date(job.publishedAt).getTime() < cutoff) return false;
    }

    return true;
  });
}
