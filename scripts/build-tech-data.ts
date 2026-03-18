// Generates src/lib/tech-entries.gen.ts from MIND-tech-ontology.
// Run: npm run build-tech-data
import fs from "fs";
import path from "path";

interface MindSkill {
  name: string;
  synonyms: string[];
  type: string[] | string;
  technicalDomains: string[];
  impliesKnowingSkills: string[];
}

const MIND_PATH = path.join(__dirname, "..", "data", "mind-skills.json");
const OUTPUT_PATH = path.join(__dirname, "..", "src", "lib", "tech-entries.gen.ts");

// Languages, frameworks, databases, tools - not niche libraries or SaaS products.
const INCLUDE_TYPES = new Set([
  "ProgrammingLanguage",
  "ScriptingLanguage",
  "MarkupLanguage",
  "QueryLanguage",
  "Framework",
  "Database",
  "Tool",
  "Webserver",
  "Protocol",
]);

const mindSkills: MindSkill[] = JSON.parse(fs.readFileSync(MIND_PATH, "utf-8"));

const seen = new Set<string>();
const entries: Array<{
  canonical: string;
  synonyms: string[];
  implies: string[];
  domains: string[];
}> = [];

for (const skill of mindSkills) {
  const types = Array.isArray(skill.type) ? skill.type : [];
  if (!types.some((t) => INCLUDE_TYPES.has(t))) continue;

  const canonical = skill.name.toLowerCase();
  if (seen.has(canonical)) continue;
  seen.add(canonical);

  entries.push({
    canonical,
    synonyms: skill.synonyms
      .map((s) => s.toLowerCase())
      .filter((s) => s !== canonical)
      .sort(),
    implies: skill.impliesKnowingSkills.map((s) => s.toLowerCase()).sort(),
    domains: skill.technicalDomains.map((d) => d.toLowerCase()).sort(),
  });
}

entries.sort((a, b) => a.canonical.localeCompare(b.canonical));

// Generate only the data - runtime logic lives in tech-data.ts
const rows = entries.map(
  (e) =>
    `  { canonical: ${JSON.stringify(e.canonical)}, ` +
    `synonyms: ${JSON.stringify(e.synonyms)}, ` +
    `implies: ${JSON.stringify(e.implies)}, ` +
    `domains: ${JSON.stringify(e.domains)} },`,
);

const output = [
  "// Auto-generated — do not edit. Run: npm run build-tech-data",
  `// Source: MIND-tech-ontology (${entries.length} techs from ${mindSkills.length} skills)`,
  "",
  "export interface TechEntry {",
  "  canonical: string;",
  "  synonyms: string[];",
  "  implies: string[];",
  "  domains: string[];",
  "}",
  "",
  "export const TECH_ENTRIES: TechEntry[] = [",
  ...rows,
  "];",
  "",
].join("\n");

fs.writeFileSync(OUTPUT_PATH, output);

const totalSynonyms = entries.reduce((sum, e) => sum + e.synonyms.length, 0);
const totalImplies = entries.reduce((sum, e) => sum + e.implies.length, 0);
console.log(
  `${OUTPUT_PATH}: ${entries.length} techs, ${totalSynonyms} synonyms, ${totalImplies} implies`,
);
