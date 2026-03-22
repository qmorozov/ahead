import axios from "axios";
import { CLEARBIT_TIMEOUT } from "../config";
import { getCachedCompanyUrl, setCachedCompanyUrl } from "../db";
import { Job } from "../types";

const CLEARBIT_URL = "https://autocomplete.clearbit.com/v1/companies/suggest";

interface LookupResult {
  url: string | null;
  transientError: boolean;
}

async function lookupCompanyUrl(name: string): Promise<LookupResult> {
  try {
    const { data } = await axios.get(CLEARBIT_URL, {
      params: { query: name },
      timeout: CLEARBIT_TIMEOUT,
    });
    if (Array.isArray(data) && data.length > 0) {
      const domain = data[0]?.domain;
      if (typeof domain === "string" && domain) {
        return { url: `https://${domain}`, transientError: false };
      }
    }
    return { url: null, transientError: false }; // genuinely not found
  } catch {
    return { url: null, transientError: true }; // network/timeout - don't cache
  }
}

async function resolveCompanyUrl(name: string): Promise<string | null> {
  const key = name.toLowerCase().trim();
  const cached = getCachedCompanyUrl(key);
  if (cached !== undefined) return cached;

  const { url, transientError } = await lookupCompanyUrl(name);
  if (!transientError) setCachedCompanyUrl(key, url); // only cache definitive results
  return url;
}

/**
 * Resolve company website URLs for jobs that lack them, using the Clearbit API.
 * Results are cached in the DB. Processes in batches of 5 for rate limiting.
 *
 * @returns Map from lowercase company name to resolved URL.
 */
export async function resolveCompanyUrls(jobs: Job[]): Promise<Map<string, string>> {
  const uniqueCompanies = new Map<string, string>();
  for (const job of jobs) {
    if (job.companyUrl || !job.company) continue;
    const key = job.company.toLowerCase().trim();
    if (!uniqueCompanies.has(key)) uniqueCompanies.set(key, job.company);
  }

  const resolvedUrls = new Map<string, string>();
  const entries = [...uniqueCompanies.entries()];
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    const results = await Promise.all(batch.map(([, name]) => resolveCompanyUrl(name)));
    for (let j = 0; j < batch.length; j++) {
      const url = results[j];
      const entry = batch[j];
      if (url && entry) resolvedUrls.set(entry[0], url);
    }
  }

  return resolvedUrls;
}
