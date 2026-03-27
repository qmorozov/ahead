// Downloads ATS company slugs from public sources and seeds the DB.
// Run: npm run seed-boards
import axios from "axios";
import { seedBoards } from "../src/db";
import { log } from "../src/lib/logger";

const REPO = "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data";

const SOURCES = {
  greenhouse: [`${REPO}/greenhouse_companies.json`],
  lever: [`${REPO}/lever_companies.json`],
  ashby: [`${REPO}/ashby_companies.json`],
  workday: [`${REPO}/workday_companies.json`],
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

  const ashby = [
    ...(await fetchJson(SOURCES.ashby[0]!)),
    ...extractSlugs(readme, /jobs\.ashbyhq\.com\/([a-zA-Z0-9_-]+)/g),
  ];

  const workday = await fetchJson(SOURCES.workday[0]!);

  const ghUnique = [...new Set(greenhouse)];
  const lvUnique = [...new Set(lever)];
  const ashUnique = [...new Set(ashby)];
  const wdUnique = [...new Set(workday)];

  log(
    `Seeding ${ghUnique.length} Greenhouse + ${lvUnique.length} Lever + ${ashUnique.length} Ashby + ${wdUnique.length} Workday boards...`,
  );
  seedBoards(ghUnique, "greenhouse");
  seedBoards(lvUnique, "lever");
  seedBoards(ashUnique, "ashby");
  seedBoards(wdUnique, "workday");
  log("Done.");
}

main().catch(console.error);
