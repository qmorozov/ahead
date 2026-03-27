import { UserSettings, getTagPreferences, type TagPreference } from "../../db";
import { Job, ParsedJob } from "../../types";
import { extractSalaryUsd } from "../../lib/salary";
import { SCORING, ATS_SOURCES } from "../../constants";
import { EXCLUDE_EXPANSIONS } from "../../bot/presets";
import {
  expandWithAliases,
  buildTagSet,
  normalizeTag,
  matchesAny,
  searchableText,
  inferTagsFromTitle,
  getStrippedDescription,
  GENERIC_TOOLS,
} from "./matching";
import { getRoleTerms, getRoleTechSet } from "./roles";
import { expandLocations, passesLocationCheck } from "./location";
import {
  scoreExcludedTech,
  scoreSeniority,
  scoreTitleKeywords,
  scoreTagOverlap,
  scoreDescriptionKeywords,
  scoreStackMatch,
  scoreRole,
  scoreForeignTech,
  scoreFreshness,
  scoreSalary,
  scoreExcludeKeywords,
  scoreJobQuality,
  scoreFeedback,
  scorePrimaryStack,
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
  expandedLocations: string[];
  acceptedLanguages: Set<string>;
  primaryStackSet: Set<string>;
  avoidedTags: Set<string>;
  preferredTags: Set<string>;
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
  | "jobQuality"
  | "feedback"
  | "primaryStack";

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
const MAX_CTX_CACHE = 500;

function settingsHash(settings: UserSettings): string {
  return [
    settings.keywords.join(","),
    settings.primaryStack.join(","),
    settings.roles.join(","),
    settings.excludeKeywords.join(","),
    settings.seniority.join(","),
    settings.locations.join(","),
    settings.workArrangement.join(","),
    settings.acceptedLanguages.join(","),
    String(settings.minSalaryUsd),
  ].join("|");
}

function expandExcludes(keywords: string[]): string[] {
  const expanded = [...keywords];
  for (const kw of keywords) {
    const extras = EXCLUDE_EXPANSIONS[kw.toLowerCase()];
    if (extras) for (const e of extras) if (!expanded.includes(e)) expanded.push(e);
  }
  return expanded;
}

export function buildScoringContext(settings: UserSettings): ScoringContext {
  const hash = settingsHash(settings);
  const cached = ctxCache.get(settings.chatId);
  if (cached && cached.hash === hash) return cached.ctx;
  const roleTerms = getRoleTerms(settings.roles);
  const roleTechSet = getRoleTechSet(settings.roles);
  const excludesWithPairs = expandExcludes(settings.excludeKeywords);
  const ctx: ScoringContext = {
    expandedKeywords: expandWithAliases([...settings.keywords, ...roleTerms]),
    stackKeywords: extractCoreStack(settings.keywords, roleTechSet),
    expandedExcludes: expandWithAliases(excludesWithPairs),
    tagSet: buildTagSet(settings.keywords),
    excludeTagSet: buildTagSet(excludesWithPairs),
    senioritySet: new Set(settings.seniority.map((s) => s.toLowerCase())),
    roleTechSet,
    roles: settings.roles,
    minSalaryUsd: settings.minSalaryUsd,
    userNonGenericCount: settings.keywords.filter((kw) => !GENERIC_TOOLS.has(normalizeTag(kw)))
      .length,
    workArrangement: settings.workArrangement,
    expandedLocations: expandLocations(settings.locations),
    acceptedLanguages: new Set(settings.acceptedLanguages.map((l) => l.toLowerCase())),
    primaryStackSet: buildTagSet(settings.primaryStack),
    avoidedTags: new Set<string>(),
    preferredTags: new Set<string>(),
  };
  ctxCache.set(settings.chatId, { hash, ctx });
  if (ctxCache.size > MAX_CTX_CACHE) {
    ctxCache.delete(ctxCache.keys().next().value!);
  }
  return ctx;
}

export function clearCachedContext(chatId: string): void {
  ctxCache.delete(chatId);
}

function analyzeJob(job: Job, parsed: ParsedJob | null): JobAnalysis {
  const parsedTags = parsed?.primaryTags ?? [];
  const hasParsedTags = parsedTags.length > 0;
  const titleTags = inferTagsFromTitle(job.title);
  const effectiveTags = hasParsedTags ? [...new Set([...parsedTags, ...titleTags])] : titleTags;
  const desc = job.description ? getStrippedDescription(job) : "";
  return { desc, titleTags, effectiveTags, parsedTags, hasParsedTags };
}

const SCORE_MAX =
  SCORING.TITLE_KEYWORD +
  SCORING.TAG_KEYWORD +
  SCORING.TAG_OVERLAP_MAX +
  SCORING.STRONG_STACK_FIT +
  SCORING.DESC_KEYWORD_MAX +
  SCORING.ROLE_MATCH +
  SCORING.ROLE_TECH_MAX +
  SCORING.SENIORITY_MATCH +
  SCORING.FRESHNESS_MAX +
  SCORING.SALARY_MATCH +
  SCORING.HIGH_QUALITY_SOURCE +
  SCORING.COMPANY_SIZE;

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
  ["feedback", scoreFeedback],
  ["primaryStack", scorePrimaryStack],
];

export function computeThreshold(ctx: ScoringContext): number {
  let t = SCORING.THRESHOLD; // base: 20
  if (ctx.expandedKeywords.length > 10) t += 5;
  if (ctx.roles.length > 0) t += 3;
  if (ctx.senioritySet.size > 0) t += 2;
  return t;
}

export function loadFeedbackIntoContext(
  chatId: string,
  ctx: ScoringContext,
): { avoided: TagPreference[]; preferred: TagPreference[] } | null {
  ctx.avoidedTags.clear();
  ctx.preferredTags.clear();
  const prefs = getTagPreferences(chatId);
  if (prefs) {
    for (const p of prefs.avoided) ctx.avoidedTags.add(normalizeTag(p.tag));
    for (const p of prefs.preferred) ctx.preferredTags.add(normalizeTag(p.tag));
  }
  return prefs;
}

export function scoreJob(
  job: Job,
  parsed: ParsedJob | null,
  ctx: ScoringContext,
  skipHardRejects = false,
): ScoreResult {
  const analysis = analyzeJob(job, parsed);
  const breakdown: Partial<Record<ScorerName, number>> = {};
  const signals: string[] = [];
  let total = 0;

  for (const [name, scorer] of scorers) {
    const r = scorer({ job, parsed, ctx, analysis });
    if (r.hardReject && !skipHardRejects) {
      return { score: -1, normalized: 0, signals: r.signals, breakdown: { [name]: -1 } };
    }
    breakdown[name] = r.hardReject ? 0 : r.score;
    total += r.hardReject ? 0 : r.score;
    signals.push(...r.signals);
  }

  const normalized = Math.round((Math.max(0, total) / SCORE_MAX) * 100);
  return { score: total, normalized, signals, breakdown };
}

export function filterJobs(jobs: Job[], settings: UserSettings, ctx: ScoringContext): Job[] {
  const {
    expandedKeywords: searchKeywords,
    expandedExcludes: excludeKeywords,
    expandedLocations: locations,
  } = ctx;

  const ageCutoff =
    settings.maxJobAgeDays > 0 ? Date.now() - settings.maxJobAgeDays * 86_400_000 : 0;

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
      const parsed = extractSalaryUsd(job.salary);
      const max = Math.max(job.salaryMinUsd ?? 0, parsed?.max ?? 0) || undefined;
      if (max !== undefined && max < settings.minSalaryUsd) return false;
    }

    if (settings.jobTypes.length > 0 && job.jobType && !settings.jobTypes.includes(job.jobType))
      return false;

    if (ageCutoff > 0 && job.publishedAt) {
      if (ATS_SOURCES.has(job.source)) {
        // ATS publishedAt is unreliable; use discoveredAt when available
        if (job.discoveredAt && job.discoveredAt < ageCutoff) return false;
      } else {
        if (new Date(job.publishedAt).getTime() < ageCutoff) return false;
      }
    }

    return true;
  });
}
