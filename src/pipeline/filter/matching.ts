function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patternCache = new Map<string, RegExp>();
const MAX_PATTERN_CACHE = 2000;

function getPattern(kw: string): RegExp {
  let re = patternCache.get(kw);
  if (!re) {
    const escaped = escapeRegex(kw);
    const startsWithWord = /^\w/.test(kw);
    const endsWithWord = /\w$/.test(kw);
    const prefix = startsWithWord ? "\\b" : "(?:^|\\W)";
    const suffix = endsWithWord ? "\\b" : "(?:$|\\W)";
    re = new RegExp(`${prefix}${escaped}${suffix}`, "i");
    patternCache.set(kw, re);
    if (patternCache.size > MAX_PATTERN_CACHE) {
      patternCache.delete(patternCache.keys().next().value!);
    }
  }
  return re;
}

export function testKeyword(text: string, kw: string): boolean {
  return getPattern(kw).test(text);
}

export function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => testKeyword(text, kw));
}

export {
  normalizeTag,
  expandWithAliases,
  buildTagSet,
  inferTagsFromTitle,
  GENERIC_TOOLS,
} from "./tags";
export { getStrippedDescription, searchableText } from "./description";
