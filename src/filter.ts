import { UserSettings } from "./db";
import { Job, ParsedJob } from "./types";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patternCache = new Map<string, RegExp>();

function getPattern(kw: string): RegExp {
  let re = patternCache.get(kw);
  if (!re) {
    re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    patternCache.set(kw, re);
  }
  return re;
}

function testKeyword(text: string, kw: string): boolean {
  return getPattern(kw).test(text);
}

function jobFull(job: Job): string {
  return [job.title, job.tags.join(" "), job.description ?? ""].join(" ");
}

function matchesKeywords(job: Job, keywords: string[]): boolean {
  const text = jobFull(job);
  return keywords.some((kw) => testKeyword(text, kw));
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

function buildTagSet(keywords: string[]): Set<string> {
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

export function isRelevantByTags(parsed: ParsedJob | null, keywords: string[]): boolean {
  if (!parsed || keywords.length === 0) return true;
  if (parsed.primaryTags.length === 0) return false;

  const kwSet = buildTagSet(keywords);
  const matched = parsed.primaryTags.filter((tag) => kwSet.has(normalizeTag(tag)));
  const threshold = Math.min(0.5, Math.max(0.12, keywords.length * 0.02));

  return matched.length >= 2 || matched.length / parsed.primaryTags.length >= threshold;
}

export function filterJobs(jobs: Job[], settings: UserSettings): Job[] {
  return jobs.filter((job) => {
    if (settings.keywords.length > 0 && !matchesKeywords(job, settings.keywords)) {
      return false;
    }

    const header = [job.title, job.tags.join(" ")].join(" ");
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
