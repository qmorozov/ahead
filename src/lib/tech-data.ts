import { TECH_ENTRIES } from "./tech-entries.gen";
export type { TechEntry } from "./tech-entries.gen";

export const SYNONYM_TO_CANONICAL = new Map<string, string>();
export const CANONICAL_TO_SYNONYMS = new Map<string, string[]>();
export const CANONICAL_TO_IMPLIES = new Map<string, string[]>();
export const CANONICAL_TO_DOMAINS = new Map<string, string[]>();
export const ALL_KNOWN_TECHS = new Set<string>();

for (const entry of TECH_ENTRIES) {
  ALL_KNOWN_TECHS.add(entry.canonical);
  if (entry.synonyms.length > 0) CANONICAL_TO_SYNONYMS.set(entry.canonical, entry.synonyms);
  for (const syn of entry.synonyms) {
    SYNONYM_TO_CANONICAL.set(syn, entry.canonical);
    ALL_KNOWN_TECHS.add(syn);
  }
  if (entry.implies.length > 0) CANONICAL_TO_IMPLIES.set(entry.canonical, entry.implies);
  if (entry.domains.length > 0) CANONICAL_TO_DOMAINS.set(entry.canonical, entry.domains);
}

// Reverse map: domain -> all techs in that domain
export const DOMAIN_TO_TECHS = new Map<string, string[]>();
for (const [tech, domains] of CANONICAL_TO_DOMAINS) {
  for (const d of domains) {
    if (!DOMAIN_TO_TECHS.has(d)) DOMAIN_TO_TECHS.set(d, []);
    DOMAIN_TO_TECHS.get(d)!.push(tech);
  }
}
