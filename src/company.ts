import axios from "axios";
import { getCachedCompanyUrl, setCachedCompanyUrl } from "./db";
import { Job } from "./types";

const CLEARBIT_URL = "https://autocomplete.clearbit.com/v1/companies/suggest";

async function lookupCompanyUrl(name: string): Promise<string | null> {
  try {
    const { data } = await axios.get(CLEARBIT_URL, {
      params: { query: name },
      timeout: 5000,
    });
    if (Array.isArray(data) && data.length > 0 && data[0].domain) {
      return `https://${data[0].domain}`;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveCompanyUrl(name: string): Promise<string | null> {
  const key = name.toLowerCase().trim();
  const cached = getCachedCompanyUrl(key);
  if (cached !== undefined) return cached;

  const url = await lookupCompanyUrl(name);
  setCachedCompanyUrl(key, url);
  return url;
}

export async function enrichCompanyUrls(jobs: Job[]): Promise<void> {
  const unique = new Map<string, string>();
  for (const job of jobs) {
    if (job.companyUrl || !job.company) continue;
    const key = job.company.toLowerCase().trim();
    if (!unique.has(key)) unique.set(key, job.company);
  }

  const urls = new Map<string, string>();
  const entries = [...unique.entries()];
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    const results = await Promise.all(batch.map(([, name]) => resolveCompanyUrl(name)));
    batch.forEach(([key], j) => {
      if (results[j]) urls.set(key, results[j]);
    });
  }

  for (const job of jobs) {
    if (!job.companyUrl && job.company) {
      job.companyUrl = urls.get(job.company.toLowerCase().trim());
    }
  }
}
