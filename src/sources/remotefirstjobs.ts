import { rssParser, RssItemSchema } from "../lib/utils";
import { Job } from "../types";

const FEED_URL = "https://remotefirstjobs.com/remote-jobs.rss";

/** Fetch remote jobs from the RemoteFirstJobs RSS feed. */
export async function fetchRemoteFirstJobs(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);
  const jobs: Job[] = [];

  for (const raw of feed.items) {
    const result = RssItemSchema.safeParse(raw);
    if (!result.success) continue;
    const item = result.data;

    jobs.push({
      id: item.guid ?? item.link ?? "",
      title: item.title ?? "",
      company: (item.title ?? "").match(/\s+at\s+(.+?)(?:\s*\(|$)/i)?.[1]?.trim() ?? "",
      location: "Remote",
      description: item.content || item.contentSnippet,
      url: item.link ?? "",
      source: "RemoteFirstJobs",
      tags: item.categories ?? [],
      publishedAt: item.isoDate ?? new Date().toISOString(),
    });
  }

  return jobs;
}
