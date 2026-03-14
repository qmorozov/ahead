import { UserSettings } from "./db";
import { Job, ParsedJob } from "./types";
import { SENIORITY_PATTERNS } from "./utils";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patternCache = new Map<string, RegExp>();
const MAX_PATTERN_CACHE = 500;

function getPattern(kw: string): RegExp {
  let re = patternCache.get(kw);
  if (!re) {
    const escaped = escapeRegex(kw);
    const startsWithWord = /^\w/.test(kw);
    const endsWithWord = /\w$/.test(kw);
    const prefix = startsWithWord ? "\\b" : "(?:^|\\W)";
    const suffix = endsWithWord ? "\\b" : "(?:$|\\W)";
    re = new RegExp(`${prefix}${escaped}${suffix}`, "i");
    if (patternCache.size >= MAX_PATTERN_CACHE) {
      const first = patternCache.keys().next().value;
      if (first !== undefined) patternCache.delete(first);
    }
    patternCache.set(kw, re);
  }
  return re;
}

function testKeyword(text: string, kw: string): boolean {
  return getPattern(kw).test(text);
}

function jobHeader(job: Job): string {
  return [job.title, job.tags.join(" ")].join(" ");
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => testKeyword(text, kw));
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[.\-\s/]/g, "");
}

const TAG_ALIASES: Record<string, string[]> = {
  react: ["reactjs"],
  node: ["nodejs"],
  vue: ["vuejs"],
  next: ["nextjs"],
  nuxt: ["nuxtjs"],
  postgres: ["postgresql", "psql"],
  mongo: ["mongodb"],
  k8s: ["kubernetes"],
  js: ["javascript"],
  ts: ["typescript"],
  tailwind: ["tailwindcss"],
  graphql: ["gql"],
};

export function buildTagSet(keywords: string[]): Set<string> {
  const set = new Set<string>();
  for (const kw of keywords) {
    const normalized = normalizeTag(kw);
    set.add(normalized);
    for (const [canonical, aliases] of Object.entries(TAG_ALIASES)) {
      if (normalized === canonical || aliases.includes(normalized)) {
        set.add(canonical);
        for (const alias of aliases) set.add(alias);
      }
    }
  }
  return set;
}

export function matchesSeniority(
  title: string,
  parsed: ParsedJob | null,
  normalizedAllowed: Set<string>,
): boolean {
  if (normalizedAllowed.size === 0) return true;

  if (parsed?.seniority) {
    return normalizedAllowed.has(parsed.seniority.toLowerCase());
  }

  let detected = false;
  for (const [label, re] of SENIORITY_PATTERNS) {
    if (re.test(title)) {
      detected = true;
      if (normalizedAllowed.has(label.toLowerCase())) return true;
    }
  }

  return !detected;
}

export function isRelevantByTags(parsed: ParsedJob | null, tagSet: Set<string>, keywordCount: number): boolean {
  if (keywordCount === 0) return true;
  if (!parsed || parsed.primaryTags.length === 0) return true;

  const matched = parsed.primaryTags.filter((tag) => tagSet.has(normalizeTag(tag)));
  const threshold = Math.min(0.5, Math.max(0.12, keywordCount * 0.02));

  return matched.length / parsed.primaryTags.length >= threshold;
}

export function filterJobs(jobs: Job[], settings: UserSettings): Job[] {
  return jobs.filter((job) => {
    const header = jobHeader(job);

    if (settings.keywords.length > 0 && !matchesAny(header, settings.keywords)) {
      return false;
    }

    if (settings.excludeKeywords.length > 0 && matchesAny(header, settings.excludeKeywords)) {
      return false;
    }

    if (settings.locations.length > 0 && job.location && !matchesAny(job.location, settings.locations)) {
      return false;
    }

    if (settings.maxJobAgeDays > 0 && job.publishedAt) {
      const jobDate = new Date(job.publishedAt).getTime();
      const cutoff = Date.now() - settings.maxJobAgeDays * 24 * 60 * 60 * 1000;
      if (jobDate < cutoff) return false;
    }

    return true;
  });
}
