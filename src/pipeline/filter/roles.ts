import { DOMAIN_TO_TECHS } from "../../lib/tech-data";
import { buildTagSet } from "./matching";

interface RoleConfig {
  titlePattern: RegExp;
  searchTerms: string[];
  domains: string[];
}

// Generic "Software Engineer/Developer" pattern — matches any dev role the user selected.
// Used as a fallback so these titles don't get a NO_ROLE penalty.
export const GENERIC_DEV_PATTERN =
  /^(?!.*(?:front|back|full.?stack|mobile|ios|android|data|ml|ai|devops|sre|infra|platform|cloud|design|product|qa|quality|test|sdet)).*\b(?:software|web)\s*(?:engineer|developer|architect)\b/i;

export const ROLE_CONFIGS: Record<string, RoleConfig> = {
  frontend: {
    titlePattern: /front.?end|UI\s*(developer|engineer)|web\s*developer/i,
    searchTerms: ["frontend", "front-end", "UI developer", "web developer"],
    domains: ["frontend"],
  },
  backend: {
    titlePattern: /back.?end|server.?side|API\s*(developer|engineer)/i,
    searchTerms: ["backend", "back-end", "API developer"],
    domains: ["backend"],
  },
  fullstack: {
    titlePattern: /full.?stack/i,
    searchTerms: ["fullstack", "full stack", "full-stack"],
    domains: ["frontend", "backend"],
  },
  devops: {
    titlePattern: /devops|SRE|site.?reliab|infra|platform.?eng|cloud.?eng/i,
    searchTerms: ["devops", "SRE", "infrastructure", "platform engineer", "cloud engineer"],
    domains: ["devops"],
  },
  "data & ml": {
    titlePattern: /data.?(scientist|engineer|analyst)|machine.?learn|ML\s*engineer|AI\s*engineer/i,
    searchTerms: [
      "data scientist",
      "data engineer",
      "machine learning",
      "ml engineer",
      "AI engineer",
    ],
    domains: ["data science", "ml/ai"],
  },
  mobile: {
    titlePattern:
      /\bmobile\s*(developer|engineer)|iOS\s*(developer|engineer)|android\s*(developer|engineer)/i,
    searchTerms: ["mobile developer", "iOS developer", "android developer"],
    domains: ["mobile"],
  },
  design: {
    titlePattern: /\bdesigner\b|UI\/UX|product.?design/i,
    searchTerms: ["designer", "UX", "UI/UX", "product design"],
    domains: [],
  },
  product: {
    titlePattern: /product.?manager|product.?owner/i,
    searchTerms: ["product manager", "product owner"],
    domains: [],
  },
  qa: {
    titlePattern: /QA|quality.?assur|test.?eng|SDET/i,
    searchTerms: ["QA engineer", "quality assurance", "test engineer", "SDET"],
    domains: ["qa/testing"],
  },
};

export function getRoleTerms(roles: string[]): string[] {
  return roles.flatMap((r) => ROLE_CONFIGS[r.toLowerCase()]?.searchTerms ?? [r.toLowerCase()]);
}

export function getRoleTechSet(roles: string[]): Set<string> {
  const techs: string[] = [];
  for (const role of roles) {
    const config = ROLE_CONFIGS[role.toLowerCase()];
    if (!config) continue;
    for (const domain of config.domains) {
      const domainTechs = DOMAIN_TO_TECHS.get(domain);
      if (domainTechs) techs.push(...domainTechs);
    }
  }
  return buildTagSet(techs);
}
