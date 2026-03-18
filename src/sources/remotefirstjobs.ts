import { rssParser } from "../lib/utils";
import { Job } from "../types";

const FEED_URL = "https://remotefirstjobs.com/remote-jobs.rss";

export async function fetchRemoteFirstJobs(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);

  return feed.items.map((item) => ({
    id: item.guid ?? item.link ?? "",
    title: item.title ?? "",
    company: (item.title ?? "").match(/\s+at\s+(.+?)(?:\s*\(|$)/i)?.[1]?.trim() ?? "",
    location: "Remote",
    description: item.content || item.contentSnippet,
    url: item.link ?? "",
    source: "RemoteFirstJobs",
    tags: item.categories ?? [],
    publishedAt: item.isoDate ?? new Date().toISOString(),
  }));
}
