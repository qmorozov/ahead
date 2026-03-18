// Downloads Greenhouse and Lever company slugs from public sources and seeds the DB
// Run: npm run seed-boards
import axios from "axios";
import { seedBoards } from "../src/db";
import { log } from "../src/lib/logger";

const SOURCES = {
  greenhouse: [
    "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/greenhouse_companies.json",
  ],
  lever: [
    "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/lever_companies.json",
  ],
};

// Extra slugs scraped from a curated README (boards.greenhouse.io/X, jobs.lever.co/X)
const EXTRA_README_URL =
  "https://raw.githubusercontent.com/sample-resume/awesome-easy-apply/main/README.md";

async function fetchJson(url: string): Promise<string[]> {
  const { data } = await axios.get(url, { timeout: 30_000 });
  return Array.isArray(data) ? data : [];
}

function extractSlugs(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((m) => m.replace(pattern.source.split("(")[0]!, ""));
}

async function main() {
  const { data: readme } = await axios.get<string>(EXTRA_README_URL, { timeout: 30_000 });

  const greenhouse = [
    ...(await fetchJson(SOURCES.greenhouse[0]!)),
    ...extractSlugs(readme, /boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/g),
  ];

  const lever = [
    ...(await fetchJson(SOURCES.lever[0]!)),
    ...extractSlugs(readme, /jobs\.lever\.co\/([a-zA-Z0-9_-]+)/g),
  ];

  const ghUnique = [...new Set(greenhouse)];
  const lvUnique = [...new Set(lever)];

  log(`Seeding ${ghUnique.length} Greenhouse + ${lvUnique.length} Lever boards...`);
  seedBoards(ghUnique, "greenhouse");
  seedBoards(lvUnique, "lever");
  log("Done.");
}

main().catch(console.error);
