import { UserSettings } from "./db";
import { Job, ParsedJob } from "./types";
import { SENIORITY_PATTERNS, extractSalaryUsd, stripHtml } from "./utils";

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
  next: ["nextjs", "next.js"],
  nuxt: ["nuxtjs"],
  postgres: ["postgresql", "psql"],
  mongo: ["mongodb"],
  k8s: ["kubernetes"],
  javascript: [],
  typescript: [],
  tailwind: ["tailwindcss"],
  graphql: ["gql"],
  golang: ["go"],
  dotnet: [".net", "asp.net", "c#", "csharp"],
  cpp: ["c++"],
  aws: ["amazon web services"],
  gcp: ["google cloud", "google cloud platform"],
  azure: ["microsoft azure"],
  ml: ["machine learning"],
  ai: ["artificial intelligence"],
  cicd: ["ci/cd", "continuous integration"],
  docker: ["containers", "containerization"],
  rest: ["restful", "rest api"],
  sass: ["scss"],
  fullstack: ["full stack", "full-stack"],
  rails: ["ruby on rails"],
  spring: ["spring boot"],
};

function expandWithAliases(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const normalized = normalizeTag(kw);
    for (const [canonical, aliases] of Object.entries(TAG_ALIASES)) {
      if (normalized === canonical || aliases.some((a) => normalizeTag(a) === normalized)) {
        expanded.add(canonical);
        for (const alias of aliases) expanded.add(alias);
      }
    }
  }
  return [...expanded];
}

const IMPLIED_SKILLS: Record<string, string> = {
  nextjs: "react",
  gatsby: "react",
  remix: "react",
  nuxtjs: "vue",
  express: "node",
  nestjs: "node",
  fastify: "node",
  fastapi: "python",
  django: "python",
  flask: "python",
  spring: "java",
  springboot: "java",
  rails: "ruby",
  rubyonrails: "ruby",
  laravel: "php",
  flutter: "dart",
  swiftui: "swift",
  jetpackcompose: "kotlin",
  terraform: "devops",
  ansible: "devops",
  pytorch: "python",
  tensorflow: "python",
  pandas: "python",
  scikitlearn: "python",
};

function buildTagSet(keywords: string[]): Set<string> {
  const set = new Set<string>();
  for (const kw of keywords) {
    const normalized = normalizeTag(kw);
    set.add(normalized);
    for (const [canonical, aliases] of Object.entries(TAG_ALIASES)) {
      if (normalized === canonical || aliases.some((a) => normalizeTag(a) === normalized)) {
        set.add(canonical);
        for (const alias of aliases) set.add(normalizeTag(alias));
      }
    }
    const implied = IMPLIED_SKILLS[normalized];
    if (implied) set.add(implied);
  }
  return set;
}

const ROLE_TITLE_PATTERNS: Record<string, RegExp> = {
  frontend: /front.?end|UI\s*(developer|engineer)|web\s*developer/i,
  backend: /back.?end|server.?side|API\s*(developer|engineer)/i,
  fullstack: /full.?stack/i,
  devops: /devops|SRE|site.?reliab|infra|platform.?eng|cloud.?eng/i,
  "data & ml": /data.?(scientist|engineer|analyst)|machine.?learn|ML\s*engineer|AI\s*engineer/i,
  mobile: /mobile|iOS|android/i,
  design: /designer|UX|UI\/UX|product.?design/i,
  product: /product.?manager|product.?owner|\bPM\b/i,
  qa: /QA|quality.?assur|test.?eng|SDET/i,
};

export const ROLE_TECHS: Record<string, string[]> = {
  frontend: ["react", "vue", "angular", "next.js", "svelte", "tailwind", "css"],
  backend: ["django", "flask", "spring", "rails", "express", "fastapi", "nestjs"],
  devops: ["kubernetes", "terraform", "ansible", "ci/cd"],
  mobile: ["react native", "flutter", "swift", "kotlin"],
  "data & ml": ["tensorflow", "pytorch", "spark", "pandas", "scikit-learn"],
  design: ["figma", "sketch", "adobe xd"],
  product: ["jira", "analytics", "a/b testing"],
  qa: ["selenium", "cypress", "playwright"],
};

const ROLE_SEARCH_TERMS: Record<string, string[]> = {
  frontend: ["frontend", "front-end", "UI developer", "web developer"],
  backend: ["backend", "back-end", "API developer"],
  fullstack: ["fullstack", "full stack", "full-stack"],
  devops: ["devops", "SRE", "infrastructure", "platform engineer", "cloud engineer"],
  "data & ml": ["data scientist", "data engineer", "machine learning", "ml engineer", "AI engineer"],
  mobile: ["mobile developer", "iOS developer", "android developer"],
  design: ["designer", "UX", "UI/UX", "product design"],
  product: ["product manager", "product owner"],
  qa: ["QA engineer", "quality assurance", "test engineer", "SDET"],
};

function getRoleTechSet(roles: string[]): Set<string> {
  const techs: string[] = [];
  for (const role of roles) {
    const lower = role.toLowerCase();
    const keys = lower === "fullstack" ? ["frontend", "backend"] : [lower];
    for (const k of keys) for (const t of ROLE_TECHS[k] ?? []) techs.push(t);
  }
  return buildTagSet(techs);
}

const LOCATION_SYNONYMS: Record<string, string[]> = {
  europe: [
    "eu",
    "emea",
    "germany",
    "netherlands",
    "france",
    "spain",
    "portugal",
    "poland",
    "ireland",
    "sweden",
    "denmark",
    "norway",
    "finland",
    "austria",
    "switzerland",
    "czech",
    "romania",
    "italy",
    "belgium",
    "european union",
    "european",
    "berlin",
    "amsterdam",
    "paris",
    "barcelona",
    "madrid",
    "dublin",
    "stockholm",
    "copenhagen",
    "oslo",
    "helsinki",
    "vienna",
    "zurich",
    "prague",
    "warsaw",
    "lisbon",
    "milan",
    "rome",
    "brussels",
    "budapest",
    "bucharest",
  ],
  usa: [
    "us",
    "united states",
    "north america",
    "america",
    "new york",
    "california",
    "texas",
    "nyc",
    "sf",
    "san francisco",
    "seattle",
    "boston",
    "chicago",
    "austin",
    "denver",
    "los angeles",
    "miami",
  ],
  uk: [
    "united kingdom",
    "great britain",
    "england",
    "london",
    "manchester",
    "edinburgh",
    "scotland",
    "wales",
  ],
  canada: ["toronto", "vancouver", "montreal", "ottawa"],
  asia: [
    "apac",
    "india",
    "singapore",
    "japan",
    "korea",
    "china",
    "vietnam",
    "philippines",
    "indonesia",
    "thailand",
    "hong kong",
    "taiwan",
    "southeast asia",
  ],
};

function expandLocations(locations: string[]): string[] {
  const expanded = new Set(locations);
  for (const loc of locations) {
    const synonyms = LOCATION_SYNONYMS[loc.toLowerCase()];
    if (synonyms) for (const s of synonyms) expanded.add(s);
  }
  return [...expanded];
}

// FIXME: doesn't handle "Remote (US/EU)" — need to split on "/" and check each region
const REMOTE_QUALIFIER_RE =
  /remote\s*[(\-–,]\s*(.+?)\s*\)?$|remote\s+(?:only|based\s+in)\s+(.+)/i;

function passesLocationCheck(location: string, expandedLocations: string[]): boolean {
  const loc = location.toLowerCase();
  if (/\bworldwide\b|\banywhere\b/.test(loc)) return true;

  if (/\bremote\b/.test(loc)) {
    const m = REMOTE_QUALIFIER_RE.exec(loc);
    const qualifier = (m?.[1] ?? m?.[2] ?? "").trim();
    if (!qualifier) return true;
    return matchesAny(qualifier, expandedLocations);
  }

  return matchesAny(location, expandedLocations);
}

function matchesSeniority(title: string, parsed: ParsedJob | null, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  if (parsed?.seniority) return allowed.has(parsed.seniority.toLowerCase());

  let detected = false;
  for (const [label, re] of SENIORITY_PATTERNS) {
    if (re.test(title)) {
      detected = true;
      if (allowed.has(label.toLowerCase())) return true;
    }
  }
  return !detected;
}

function seniorityDetected(title: string, parsed: ParsedJob | null): boolean {
  if (parsed?.seniority) return true;
  return SENIORITY_PATTERNS.some(([, re]) => re.test(title));
}

const GENERIC_TOOLS = new Set([
  "git", "github", "gitlab", "bitbucket",
  "docker", "linux", "unix", "bash", "shell",
  "sql", "nosql", "postgresql", "mysql", "mongodb", "mariadb", "sqlite",
  "rest api", "restful", "graphql", "grpc",
  "ci/cd", "ci cd",
  "microservices", "monorepo",
  "agile", "scrum", "kanban",
  "jira", "confluence", "slack", "figma",
  "aws", "gcp", "azure",
  "pytest", "jest", "testing",
  "redis", "elasticsearch", "rabbitmq", "kafka",
  "nginx", "elk stack",
]);

function splitStackAndTools(keywords: string[]): { stack: string[]; all: string[] } {
  const stack = keywords.filter((kw) => !GENERIC_TOOLS.has(kw.toLowerCase()));
  return { stack: expandWithAliases(stack), all: expandWithAliases(keywords) };
}

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
}

export function buildScoringContext(settings: UserSettings): ScoringContext {
  const roleTerms = settings.roles.flatMap(
    (r) => ROLE_SEARCH_TERMS[r.toLowerCase()] ?? [r.toLowerCase()],
  );
  const { stack, all } = splitStackAndTools(settings.keywords);
  return {
    expandedKeywords: expandWithAliases([...settings.keywords, ...roleTerms]),
    stackKeywords: stack,
    expandedExcludes: expandWithAliases(settings.excludeKeywords),
    tagSet: buildTagSet(settings.keywords),
    excludeTagSet: buildTagSet(settings.excludeKeywords),
    senioritySet: new Set(settings.seniority.map((s) => s.toLowerCase())),
    roleTechSet: getRoleTechSet(settings.roles),
    roles: settings.roles,
    minSalaryUsd: settings.minSalaryUsd,
  };
}

export interface ScoreResult {
  score: number;
  signals: string[];
}

export function scoreJob(job: Job, parsed: ParsedJob | null, ctx: ScoringContext): ScoreResult {
  const signals: string[] = [];

  if (ctx.excludeTagSet.size > 0 && parsed && parsed.primaryTags.length > 0) {
    if (parsed.primaryTags.some((tag) => ctx.excludeTagSet.has(normalizeTag(tag))))
      return { score: -1, signals: ["excluded tech"] };
  }

  if (ctx.senioritySet.size > 0 && seniorityDetected(job.title, parsed)) {
    if (!matchesSeniority(job.title, parsed, ctx.senioritySet))
      return { score: -1, signals: ["seniority mismatch"] };
  }

  let score = 0;
  const desc = job.description ? stripHtml(job.description).slice(0, 2000) : "";

  if (ctx.expandedKeywords.length > 0 && matchesAny(job.title, ctx.expandedKeywords)) {
    score += 25;
    const matched = ctx.expandedKeywords.filter((kw) => testKeyword(job.title, kw));
    signals.push(`${matched.join(", ")} in title`);
  }

  if (ctx.expandedKeywords.length > 0 && job.tags.length > 0 && matchesAny(job.tags.join(" "), ctx.expandedKeywords))
    score += 15;

  if (parsed && parsed.primaryTags.length > 0 && ctx.tagSet.size > 0) {
    const matched = parsed.primaryTags.filter((tag) => ctx.tagSet.has(normalizeTag(tag)));
    if (matched.length > 0) {
      score += 20 + (matched.length - 1) * 5;
      signals.push(`${matched.join(", ")} tags`);
    }
    const nonGenericMatched = matched.filter((tag) => !GENERIC_TOOLS.has(tag.toLowerCase()));
    if (parsed.primaryTags.length >= 4 && nonGenericMatched.length / parsed.primaryTags.length <= 0.25) {
      return { score: -1, signals: ["low tag overlap"] };
    }
  }

  if (ctx.expandedKeywords.length > 0 && desc) {
    const n = ctx.expandedKeywords.filter((kw) => testKeyword(desc, kw)).length;
    if (n > 0) score += Math.min(n * 3, 15);
  }

  if (ctx.stackKeywords.length > 0) {
    const titleHit = matchesAny(job.title, ctx.stackKeywords);
    const tagHits = job.tags.length > 0 ? ctx.stackKeywords.filter((kw) => testKeyword(job.tags.join(" "), kw)).length : 0;
    const llmHit = parsed && parsed.primaryTags.length > 0 && parsed.primaryTags.some((tag) => {
      const norm = normalizeTag(tag);
      return ctx.tagSet.has(norm) && !GENERIC_TOOLS.has(tag.toLowerCase());
    });
    const descHits = desc ? ctx.stackKeywords.filter((kw) => testKeyword(desc, kw)).length : 0;

    if (!titleHit && !llmHit) {
      if (tagHits < 2 && descHits < 2) return { score: -1, signals: ["no stack match"] };
    }
  }

  if (ctx.roles.length > 0) {
    const userRoles = new Set(ctx.roles.map((r) => r.toLowerCase()));
    for (const [role, pattern] of Object.entries(ROLE_TITLE_PATTERNS)) {
      if (!userRoles.has(role) && pattern.test(job.title)) {
        return { score: -1, signals: [`wrong role: ${role}`] };
      }
    }
  }

  let roleMatched = false;
  if (ctx.roles.length > 0) {
    for (const role of ctx.roles) {
      const pattern = ROLE_TITLE_PATTERNS[role.toLowerCase()];
      if (pattern?.test(job.title)) {
        score += 15;
        signals.push(role);
        roleMatched = true;
        break;
      }
    }
  }

  if (ctx.roleTechSet.size > 0 && parsed && parsed.primaryTags.length > 0) {
    const n = parsed.primaryTags.filter((tag) => ctx.roleTechSet.has(normalizeTag(tag))).length;
    if (n >= 2) { score += 10; roleMatched = true; }
    else if (n === 1) { score += 5; roleMatched = true; }
  }

  if (ctx.roles.length > 0 && !roleMatched) score -= 15;

  if (
    ctx.senioritySet.size > 0 &&
    seniorityDetected(job.title, parsed) &&
    matchesSeniority(job.title, parsed, ctx.senioritySet)
  ) {
    score += 10;
    signals.push(parsed?.seniority ?? "level match");
  }

  if (job.publishedAt) {
    const h = (Date.now() - new Date(job.publishedAt).getTime()) / 3_600_000;
    if (h < 24) score += 5;
    else if (h < 72) score += 3;
    else if (h < 168) score += 1;
  }

  if (ctx.minSalaryUsd > 0) {
    const sal = extractSalaryUsd(job.salary);
    const max = sal?.max ?? job.salaryMinUsd;
    if (max !== undefined && max >= ctx.minSalaryUsd) {
      score += 5;
      signals.push(`$${Math.round(max / 1000)}k+`);
    }
  }

  if (ctx.expandedExcludes.length > 0 && parsed) {
    if (parsed.requirements.some((r) => matchesAny(r, ctx.expandedExcludes))) score -= 30;
    if (parsed.niceToHave.some((r) => matchesAny(r, ctx.expandedExcludes))) score -= 10;
  }

  if (ctx.expandedExcludes.length > 0 && desc) {
    if (matchesAny(desc, ctx.expandedExcludes)) score -= 15;
  }

  return { score, signals };
}

function searchableText(job: Job): string {
  const parts = [job.title, job.tags.join(" ")];
  if (job.description) parts.push(stripHtml(job.description).slice(0, 2000));
  return parts.join(" ");
}

export function filterJobs(jobs: Job[], settings: UserSettings): Job[] {
  const roleTerms = settings.roles.flatMap(
    (r) => ROLE_SEARCH_TERMS[r.toLowerCase()] ?? [r.toLowerCase()],
  );
  const searchKeywords = expandWithAliases([...settings.keywords, ...roleTerms]);
  const excludeKeywords = expandWithAliases(settings.excludeKeywords);
  const locations = expandLocations(settings.locations);

  return jobs.filter((job) => {
    const text = searchableText(job);
    const header = [job.title, job.tags.join(" ")].join(" ");

    if (searchKeywords.length > 0 && !matchesAny(text, searchKeywords)) return false;
    if (excludeKeywords.length > 0 && matchesAny(header, excludeKeywords)) return false;

    if (locations.length > 0 && job.location) {
      if (!passesLocationCheck(job.location, locations)) return false;
    }

    if (settings.minSalaryUsd > 0) {
      const sal = extractSalaryUsd(job.salary);
      const max = sal?.max ?? job.salaryMinUsd;
      if (max !== undefined && max < settings.minSalaryUsd) return false;
    }

    if (settings.maxJobAgeDays > 0 && job.publishedAt) {
      const cutoff = Date.now() - settings.maxJobAgeDays * 24 * 60 * 60 * 1000;
      if (new Date(job.publishedAt).getTime() < cutoff) return false;
    }

    return true;
  });
}
