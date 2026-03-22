import {
  SYNONYM_TO_CANONICAL,
  CANONICAL_TO_SYNONYMS,
  CANONICAL_TO_IMPLIES,
  CANONICAL_TO_DOMAINS,
  ALL_KNOWN_TECHS,
} from "../../lib/tech-data";
import { testKeyword } from "./matching";

/** Strip dots, dashes, spaces, slashes and lowercase: "Node.js" → "nodejs". */
export function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[.\-\s/]/g, "");
}

function resolveCanonical(kw: string): { canonical: string; synonyms: string[] } | null {
  const normalized = normalizeTag(kw);
  // Direct canonical hit (kw is already a canonical name)
  const directSyns = CANONICAL_TO_SYNONYMS.get(normalized);
  if (directSyns) return { canonical: normalized, synonyms: directSyns };
  // Synonym hit (kw is an alias for a canonical name)
  const canonical =
    SYNONYM_TO_CANONICAL.get(normalized) ?? SYNONYM_TO_CANONICAL.get(kw.toLowerCase());
  if (canonical) {
    return { canonical, synonyms: CANONICAL_TO_SYNONYMS.get(canonical) ?? [] };
  }
  return null;
}

const SKIP_KEYWORD_EXPAND = new Set(["c", "r", "js", "ts", "py"]);

export function expandWithAliases(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const resolved = resolveCanonical(kw);
    if (!resolved) continue;
    if (!SKIP_KEYWORD_EXPAND.has(resolved.canonical)) expanded.add(resolved.canonical);
    for (const syn of resolved.synonyms) {
      if (!SKIP_KEYWORD_EXPAND.has(syn)) expanded.add(syn);
    }
  }
  return [...expanded];
}

/** Build a Set of all normalized forms for matching (canonical + synonyms + implies). */
export function buildTagSet(keywords: string[]): Set<string> {
  const set = new Set<string>();
  for (const kw of keywords) {
    const normalized = normalizeTag(kw);
    set.add(normalized);
    const resolved = resolveCanonical(kw);
    if (!resolved) continue;
    set.add(resolved.canonical);
    for (const syn of resolved.synonyms) set.add(normalizeTag(syn));
    const implies = CANONICAL_TO_IMPLIES.get(resolved.canonical);
    if (implies) for (const imp of implies) set.add(normalizeTag(imp));
  }
  return set;
}

// Ambiguous short words that match common English
const AMBIGUOUS_TECHS = new Set(["go", "c", "r", "d", "v", "s"]);

// Index: single-word techs looked up via Set (O(words) not O(techs)).
// Multi-word techs (e.g. "rest api", "ci/cd") checked via includes() fallback.
const SINGLE_WORD_TECHS = new Set<string>();
const MULTI_WORD_TECHS: Array<[string, string]> = [];
for (const tech of ALL_KNOWN_TECHS) {
  if (AMBIGUOUS_TECHS.has(tech)) continue;
  if (/[\s/]/.test(tech)) {
    MULTI_WORD_TECHS.push([tech, tech.toLowerCase()]);
  } else {
    SINGLE_WORD_TECHS.add(tech.toLowerCase());
  }
}

// Split title into candidate tokens for Set lookup
function extractTokens(lower: string): string[] {
  return lower.split(/[\s,|·•–—/()[\]{}]+/).filter(Boolean);
}

export function inferTagsFromTitle(title: string): string[] {
  const tags = new Set<string>();
  const lower = title.toLowerCase();

  function addTech(tech: string): void {
    const canonical = SYNONYM_TO_CANONICAL.get(tech) ?? tech;
    tags.add(canonical);
    const domains = CANONICAL_TO_DOMAINS.get(canonical);
    if (domains) for (const d of domains) tags.add(d);
  }

  // O(tokens): lookup each word in the single-word index
  for (const token of extractTokens(lower)) {
    if (SINGLE_WORD_TECHS.has(token) && testKeyword(title, token)) addTech(token);
  }

  // O(multi-word techs ~30): substring check + regex confirm for multi-word entries
  for (const [tech, techLower] of MULTI_WORD_TECHS) {
    if (!lower.includes(techLower)) continue;
    if (!testKeyword(title, tech)) continue;
    addTech(tech);
  }

  return [...tags];
}

const GENERIC_TOOLS_RAW = [
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

/** Tools common enough that they don't differentiate stacks (git, docker, sql, etc.). */
export const GENERIC_TOOLS = new Set(GENERIC_TOOLS_RAW.flatMap((t) => [t, normalizeTag(t)]));
