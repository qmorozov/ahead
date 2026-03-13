import Parser from "rss-parser";
import { Job } from "../types";

const parser = new Parser({
  timeout: 15_000,
});

const FEEDS = ["https://weworkremotely.com/remote-jobs.rss"];

export async function fetchWeWorkRemotely(): Promise<Job[]> {
  const jobs: Job[] = [];

  for (const feedUrl of FEEDS) {
    const feed = await parser.parseURL(feedUrl);

    for (const item of feed.items) {
      jobs.push({
        id: item.guid ?? item.link ?? "",
        title: extractTitle(item.title ?? ""),
        company: extractCompany(item.title ?? ""),
        location: "Remote",
        description: item.content || item.contentSnippet,
        url: item.link ?? "",
        source: "WeWorkRemotely",
        tags: item.categories ?? [],
        publishedAt: item.isoDate ?? new Date().toISOString(),
      });
    }
  }

  return jobs;
}

function extractCompany(title: string): string {
  const colonIndex = title.indexOf(":");
  if (colonIndex > 0) {
    return title.substring(0, colonIndex).trim();
  }
  return "";
}

function extractTitle(title: string): string {
  const colonIndex = title.indexOf(":");
  if (colonIndex > 0) {
    return title.substring(colonIndex + 1).trim();
  }
  return title;
}
