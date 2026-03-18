import { rssParser } from "../lib/utils";
import { Job } from "../types";

const FEED_URL = "https://weworkremotely.com/remote-jobs.rss";

export async function fetchWeWorkRemotely(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);

  return feed.items.map((item) => {
    const raw = item.title ?? "";
    const colon = raw.indexOf(":");
    const [company, title] =
      colon > 0 ? [raw.substring(0, colon).trim(), raw.substring(colon + 1).trim()] : ["", raw];

    return {
      id: item.guid ?? item.link ?? "",
      title,
      company,
      location: "Remote",
      description: item.content || item.contentSnippet,
      url: item.link ?? "",
      source: "WeWorkRemotely",
      tags: item.categories ?? [],
      publishedAt: item.isoDate ?? new Date().toISOString(),
    };
  });
}
