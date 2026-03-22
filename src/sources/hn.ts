import { rssParser, RssItemSchema } from "../lib/utils";
import { Job } from "../types";

const FEED_URL = "https://hnrss.org/whoishiring/jobs?count=100";

interface ParsedPosting {
  company: string;
  title: string;
  location: string;
  tags: string[];
}

// Parse "Company | Title | Location | Tech1, Tech2" header
function parsePosting(text: string): ParsedPosting {
  const result: ParsedPosting = { company: "", title: "", location: "", tags: [] };

  const firstLine = text.split("\n")[0] ?? "";
  const parts = firstLine.split("|").map((s) => s.trim());

  if (parts.length >= 2) {
    result.company = parts[0] ?? "";

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i] ?? "";
      const lower = part.toLowerCase();

      if (!result.title && isTitle(lower)) {
        result.title = part;
      } else if (!result.location && isLocation(lower)) {
        result.location = part;
      }
    }

    const techParts = parts.filter((p) => isTech(p.toLowerCase()));
    for (const tp of techParts) {
      result.tags.push(
        ...tp
          .split(/[,/]/)
          .map((t) => t.trim())
          .filter(Boolean),
      );
    }
  }

  return result;
}

function isTitle(s: string): boolean {
  return /\b(engineer|developer|designer|manager|lead|architect|devops|sre|qa|analyst|scientist|intern)\b/i.test(
    s,
  );
}

function isLocation(s: string): boolean {
  return /\b(remote|onsite|hybrid|usa|europe|worldwide|global|uk|canada|germany|berlin|nyc|sf|san francisco)\b/i.test(
    s,
  );
}

function isTech(s: string): boolean {
  return /\b(react|node|python|java|go|rust|typescript|ruby|rails|aws|gcp|azure|kubernetes|docker|postgres|graphql|vue|angular|swift|kotlin)\b/i.test(
    s,
  );
}

/** Fetch HN "Who is Hiring?" jobs via RSS. */
export async function fetchHN(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);
  const jobs: Job[] = [];

  for (const raw of feed.items) {
    const result = RssItemSchema.safeParse(raw);
    if (!result.success) continue;
    const item = result.data;

    const text = item.contentSnippet ?? item.content ?? "";
    if (text.length < 20) continue;

    const parsed = parsePosting(text);
    if (!parsed.company) continue;

    jobs.push({
      id: item.guid ?? item.link ?? "",
      title: parsed.title || "",
      company: parsed.company,
      location: parsed.location || "Remote",
      description: item.content,
      url: item.link ?? "",
      source: "HN",
      tags: parsed.tags,
      publishedAt: item.isoDate ?? new Date().toISOString(),
    });
  }

  return jobs;
}
