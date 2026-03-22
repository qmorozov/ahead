import axios from "axios";
import { HTTP_TIMEOUT } from "../config";
import { rssParser, RssItemSchema } from "../lib/utils";
import { Job } from "../types";
import { logOperationalError } from "../lib/errors";

const FEED_URL = "https://djinni.co/jobs/rss/";

export async function fetchDjinni(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);
  const jobs: Job[] = [];

  for (const raw of feed.items) {
    const result = RssItemSchema.safeParse(raw);
    if (!result.success) continue;
    const item = result.data;

    jobs.push({
      id: item.guid ?? item.link ?? "",
      title: item.title ?? "",
      company: "", // resolved via enrichment (JSON-LD)
      location: "",
      description: item.content || item.contentSnippet,
      url: item.link ?? "",
      source: "Djinni",
      tags: item.categories?.filter(Boolean) ?? [],
      publishedAt: item.isoDate ?? new Date().toISOString(),
    });
  }

  return jobs;
}

// RSS description HTML is too unreliable for company name extraction

interface EnrichmentData {
  company: string;
  location: string;
}

const enrichCache = new Map<string, EnrichmentData>();
const MAX_ENRICH_CACHE = 500;

function setCache(url: string, data: EnrichmentData): void {
  if (enrichCache.size >= MAX_ENRICH_CACHE) {
    const first = enrichCache.keys().next().value;
    if (first !== undefined) enrichCache.delete(first);
  }
  enrichCache.set(url, data);
}

function parseJsonLd(html: string): EnrichmentData {
  const match = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!match?.[1]) return { company: "", location: "" };

  try {
    const ld = JSON.parse(match[1]);
    return {
      company: ld.hiringOrganization?.name ?? "",
      location: ld.jobLocationType === "TELECOMMUTE" ? "Remote" : "",
    };
  } catch (err) {
    logOperationalError("Djinni JSON-LD", err);
    return { company: "", location: "" };
  }
}

export async function fetchDjinniEnrichment(url: string): Promise<EnrichmentData> {
  const cached = enrichCache.get(url);
  if (cached) return cached;

  try {
    const { data } = await axios.get(url, { timeout: HTTP_TIMEOUT });
    const enriched = parseJsonLd(typeof data === "string" ? data : "");
    setCache(url, enriched);
    return enriched;
  } catch (err) {
    logOperationalError("Djinni enrich", err);
    return cached ?? { company: "", location: "" };
  }
}
