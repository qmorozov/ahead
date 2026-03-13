import Parser from "rss-parser";
import { Job } from "../types";

const parser = new Parser({
  timeout: 15_000,
});

const FEED_URL = "https://remotefirstjobs.com/remote-jobs.rss";

export async function fetchRemoteFirstJobs(): Promise<Job[]> {
  const feed = await parser.parseURL(FEED_URL);

  return feed.items.map((item) => ({
    id: item.guid ?? item.link ?? "",
    title: item.title ?? "",
    company: extractCompany(item.title ?? ""),
    location: "Remote",
    description: item.content || item.contentSnippet,
    url: item.link ?? "",
    source: "RemoteFirstJobs",
    tags: item.categories ?? [],
    publishedAt: item.isoDate ?? new Date().toISOString(),
  }));
}

function extractCompany(title: string): string {
  const match = title.match(/\s+at\s+(.+?)(?:\s*\(|$)/i);
  return match?.[1]?.trim() ?? "";
}
