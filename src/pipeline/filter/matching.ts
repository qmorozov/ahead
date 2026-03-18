import {
  SYNONYM_TO_CANONICAL,
  CANONICAL_TO_SYNONYMS,
  CANONICAL_TO_IMPLIES,
  CANONICAL_TO_DOMAINS,
  ALL_KNOWN_TECHS,
} from "../../lib/tech-data";
import { Job, jobKey as makeJobKey } from "../../types";
import { stripHtml } from "../../lib/utils";
import { LLM } from "../../constants";

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

export function testKeyword(text: string, kw: string): boolean {
  return getPattern(kw).test(text);
}

export function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => testKeyword(text, kw));
}

export function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[.\-\s/]/g, "");
}

const SKIP_KEYWORD_EXPAND = new Set(["go", "c", "r", "js", "ts", "py"]);

export function expandWithAliases(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const normalized = normalizeTag(kw);
    const synonyms = CANONICAL_TO_SYNONYMS.get(normalized);
    if (synonyms) {
      if (!SKIP_KEYWORD_EXPAND.has(normalized)) expanded.add(normalized);
      for (const syn of synonyms) {
        if (!SKIP_KEYWORD_EXPAND.has(syn)) expanded.add(syn);
      }
      continue;
    }
    const canonical =
      SYNONYM_TO_CANONICAL.get(normalized) ?? SYNONYM_TO_CANONICAL.get(kw.toLowerCase());
    if (canonical) {
      if (!SKIP_KEYWORD_EXPAND.has(canonical)) expanded.add(canonical);
      const canonSyns = CANONICAL_TO_SYNONYMS.get(canonical);
      if (canonSyns)
        for (const syn of canonSyns) {
          if (!SKIP_KEYWORD_EXPAND.has(syn)) expanded.add(syn);
        }
    }
  }
  return [...expanded];
}

export function buildTagSet(keywords: string[]): Set<string> {
  const set = new Set<string>();
  for (const kw of keywords) {
    const normalized = normalizeTag(kw);
    set.add(normalized);
    const canonical =
      SYNONYM_TO_CANONICAL.get(normalized) ?? SYNONYM_TO_CANONICAL.get(kw.toLowerCase());
    const resolvedCanonical =
      canonical ?? (CANONICAL_TO_SYNONYMS.has(normalized) ? normalized : null);
    if (resolvedCanonical) {
      set.add(resolvedCanonical);
      const synonyms = CANONICAL_TO_SYNONYMS.get(resolvedCanonical);
      if (synonyms) for (const syn of synonyms) set.add(normalizeTag(syn));
      const implies = CANONICAL_TO_IMPLIES.get(resolvedCanonical);
      if (implies) for (const imp of implies) set.add(normalizeTag(imp));
    }
  }
  return set;
}

// Ambiguous short words that match common English
const AMBIGUOUS_TECHS = new Set(["go", "c", "r", "d", "v", "s"]);

export function inferTagsFromTitle(title: string): string[] {
  const tags = new Set<string>();
  for (const tech of ALL_KNOWN_TECHS) {
    if (AMBIGUOUS_TECHS.has(tech)) continue;
    if (!testKeyword(title, tech)) continue;
    const canonical = SYNONYM_TO_CANONICAL.get(tech) ?? tech;
    tags.add(canonical);
    const domains = CANONICAL_TO_DOMAINS.get(canonical);
    if (domains) for (const d of domains) tags.add(d);
  }
  return [...tags];
}

// Description cache
const strippedDescCache = new Map<string, string>();
const MAX_DESC_CACHE = 20_000;

function evictOldest(map: Map<string, unknown>, count: number): void {
  const keys = map.keys();
  for (let i = 0; i < count; i++) {
    const { value, done } = keys.next();
    if (done) break;
    map.delete(value);
  }
}

export function getStrippedDescription(job: Job): string {
  const key = makeJobKey(job);
  let text = strippedDescCache.get(key);
  if (text !== undefined) return text;
  text = job.description ? stripHtml(job.description).slice(0, LLM.MAX_INPUT_CHARS) : "";
  if (strippedDescCache.size >= MAX_DESC_CACHE) evictOldest(strippedDescCache, MAX_DESC_CACHE / 4);
  strippedDescCache.set(key, text);
  return text;
}

export function searchableText(job: Job): string {
  const parts = [job.title, job.tags.join(" ")];
  const desc = getStrippedDescription(job);
  if (desc) parts.push(desc);
  return parts.join(" ");
}

export const GENERIC_TOOLS_RAW = [
  "git",
  "github",
  "gitlab",
  "bitbucket",
  "docker",
  "linux",
  "unix",
  "bash",
  "shell",
  "sql",
  "nosql",
  "postgresql",
  "mysql",
  "mongodb",
  "mariadb",
  "sqlite",
  "rest api",
  "restful",
  "graphql",
  "grpc",
  "ci/cd",
  "ci cd",
  "microservices",
  "monorepo",
  "agile",
  "scrum",
  "kanban",
  "jira",
  "confluence",
  "slack",
  "figma",
  "aws",
  "gcp",
  "azure",
  "pytest",
  "jest",
  "testing",
  "redis",
  "elasticsearch",
  "rabbitmq",
  "kafka",
  "nginx",
  "elk stack",
];

export const GENERIC_TOOLS = new Set(GENERIC_TOOLS_RAW.flatMap((t) => [t, normalizeTag(t)]));
