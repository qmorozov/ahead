import axios from "axios";
import { HTTP_TIMEOUT } from "../config";
import { rssParser } from "../utils";
import { Job } from "../types";

const FEED_URL = "https://djinni.co/jobs/rss/";

export async function fetchDjinni(): Promise<Job[]> {
  const feed = await rssParser.parseURL(FEED_URL);

  return feed.items.map((item) => ({
    id: item.guid ?? item.link ?? "",
    title: item.title ?? "",
    company: extractCompany(item.content ?? ""),
    location: "",
    description: item.content || item.contentSnippet,
    url: item.link ?? "",
    source: "Djinni",
    tags: item.categories?.filter(Boolean) ?? [],
    publishedAt: item.isoDate ?? new Date().toISOString(),
  }));
}

const NOT_COMPANY =
  /^(about|project|role|position|responsibilities|requirements|overview|customer$|gambling|the\s|we\s|our\s|your\s|join\s|що|як|ми|про|вимоги|обов|опис)/i;

const JOB_TITLE_WORDS =
  /\b(intern|developer|manager|engineer|designer|analyst|specialist|lead\b|senior|junior|middle|head of|recruiter|buyer|officer)\b/i;

function extractCompany(html: string): string {
  const strong = html.match(/<strong>([^<]+)<\/strong>/);
  const raw = strong?.[1]
    ?.replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[:\u2014\u2013]/g, "")
    .trim();

  if (raw && raw.length <= 40 && !NOT_COMPANY.test(raw) && !JOB_TITLE_WORDS.test(raw)) {
    return raw;
  }

  return "";
}

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
  } catch {
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
  } catch {
    setCache(url, { company: "", location: "" });
    return { company: "", location: "" };
  }
}
