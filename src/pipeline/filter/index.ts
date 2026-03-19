import { UserSettings } from "../../db";
import { Job, ParsedJob } from "../../types";
import { extractSalaryUsd } from "../../lib/utils";
import { SCORING, LLM } from "../../constants";
import { expandWithAliases, buildTagSet, normalizeTag, matchesAny, searchableText, inferTagsFromTitle, getStrippedDescription, GENERIC_TOOLS } from "./matching";
import { getRoleTerms, getRoleTechSet } from "./roles";
import { expandLocations, passesLocationCheck } from "./location";
import {
  scoreExcludedTech, scoreSeniority, scoreTitleKeywords, scoreTagOverlap,
  scoreDescriptionKeywords, scoreStackMatch, scoreRole, scoreForeignTech,
  scoreFreshness, scoreSalary, scoreExcludeKeywords, scoreJobQuality,
} from "./scorers";

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

export interface ScoreResult {
  score: number;
  normalized: number;
  signals: string[];
  breakdown: Record<string, number>;
}

type Scorer = (job: Job, parsed: ParsedJob | null, ctx: ScoringContext, a: JobAnalysis) => ScorerResult;

function splitStackAndTools(keywords: string[], roleTechs: Set<string>): string[] {
  const stack = keywords.filter((kw) => {
    const lower = kw.toLowerCase();
    if (roleTechs.has(normalizeTag(lower))) return true;
    return !GENERIC_TOOLS.has(lower);
  });
  return expandWithAliases(stack);
}

export function buildScoringContext(settings: UserSettings): ScoringContext {
  const roleTerms = getRoleTerms(settings.roles);
  const roleTechSet = getRoleTechSet(settings.roles);
  return {
    expandedKeywords: expandWithAliases([...settings.keywords, ...roleTerms]),
    stackKeywords: splitStackAndTools(settings.keywords, roleTechSet),
    expandedExcludes: expandWithAliases(settings.excludeKeywords),
    tagSet: buildTagSet(settings.keywords),
    excludeTagSet: buildTagSet(settings.excludeKeywords),
    senioritySet: new Set(settings.seniority.map((s) => s.toLowerCase())),
    roleTechSet,
    roles: settings.roles,
    minSalaryUsd: settings.minSalaryUsd,
    userNonGenericCount: settings.keywords.filter((kw) => !GENERIC_TOOLS.has(normalizeTag(kw))).length,
    workArrangement: settings.workArrangement,
  };
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
  SCORING.STRONG_STACK_FIT + 15 /* desc keywords cap */ +
  SCORING.ROLE_MATCH + 10 /* role-tech max */ +
  SCORING.SENIORITY_MATCH + SCORING.FRESHNESS_MAX + SCORING.SALARY_MATCH +
  SCORING.HIGH_QUALITY_SOURCE + SCORING.COMPANY_SIZE;

const scorers: Array<[string, Scorer]> = [
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
  const breakdown: Record<string, number> = {};
  const signals: string[] = [];
  let total = 0;

  for (const [name, scorer] of scorers) {
    const r = scorer(job, parsed, ctx, analysis);
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

export function filterJobs(jobs: Job[], settings: UserSettings, ctx?: ScoringContext): Job[] {
  const searchKeywords = ctx?.expandedKeywords ?? expandWithAliases([...settings.keywords, ...getRoleTerms(settings.roles)]);
  const excludeKeywords = ctx?.expandedExcludes ?? expandWithAliases(settings.excludeKeywords);
  const locations = expandLocations(settings.locations);

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
      const sal = extractSalaryUsd(job.salary);
      const max = sal?.max ?? job.salaryMinUsd;
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
