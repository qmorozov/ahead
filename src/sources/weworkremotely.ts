import { rssParser, RssItemSchema } from "../lib/utils";
import { Job } from "../types";

const FEED_URL = "https://weworkremotely.com/remote-jobs.rss";

/** Fetch remote jobs from the WeWorkRemotely RSS feed. */
export async function fetchWeWorkRemotely(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);
  const jobs: Job[] = [];

  for (const raw of feed.items) {
    const result = RssItemSchema.safeParse(raw);
    if (!result.success) continue;
    const item = result.data;

    const fullTitle = item.title ?? "";
    const colon = fullTitle.indexOf(":");
    const [company, title] =
      colon > 0 ? [fullTitle.substring(0, colon).trim(), fullTitle.substring(colon + 1).trim()] : ["", fullTitle];

    jobs.push({
      id: item.guid ?? item.link ?? "",
      title,
      company,
      location: "Remote",
      description: item.content || item.contentSnippet,
      url: item.link ?? "",
      source: "WeWorkRemotely",
      tags: item.categories ?? [],
      publishedAt: item.isoDate ?? new Date().toISOString(),
    });
  }

  return jobs;
}
