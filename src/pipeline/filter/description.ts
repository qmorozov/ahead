import { Job, jobKey as makeJobKey } from "../../types";
import { stripHtml } from "../../lib/utils";
import { LLM } from "../../constants";

const strippedDescCache = new Map<string, string>();
const MAX_DESC_CACHE = 5_000;

// LRU-cached, truncated to LLM input limit
export function getStrippedDescription(job: Job): string {
  const key = makeJobKey(job);
  const cached = strippedDescCache.get(key);
  if (cached !== undefined) {
    // Move to end of Map for LRU ordering
    strippedDescCache.delete(key);
    strippedDescCache.set(key, cached);
    return cached;
  }
  const text = job.description ? stripHtml(job.description).slice(0, LLM.MAX_INPUT_CHARS) : "";
  if (strippedDescCache.size >= MAX_DESC_CACHE) {
    // Evict single oldest (LRU = first key in Map)
    strippedDescCache.delete(strippedDescCache.keys().next().value!);
  }
  strippedDescCache.set(key, text);
  return text;
}

export function searchableText(job: Job): string {
  const parts = [job.title, job.tags.join(" ")];
  const desc = getStrippedDescription(job);
  if (desc) parts.push(desc);
  return parts.join(" ");
}
