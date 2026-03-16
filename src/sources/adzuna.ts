import axios from "axios";
import { z } from "zod";
import { config, HTTP_TIMEOUT } from "../config";
import { Job } from "../types";
import { formatSalaryRange } from "../format";
import { logError } from "../logger";
import { stripHtml } from "../utils";

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().default(""),
  company: z.object({ display_name: z.string().default("") }).default({ display_name: "" }),
  location: z.object({ display_name: z.string().default("") }).default({ display_name: "" }),
  description: z.string().optional(),
  redirect_url: z.string().default(""),
  category: z.object({ tag: z.string().default("") }).default({ tag: "" }),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  created: z.string().default(""),
});

const ResponseSchema = z.object({
  results: z.array(JobSchema).default([]),
});

const COUNTRIES = ["gb", "us", "de", "fr", "au", "ca", "pl"];
const COUNTRY_CURRENCY: Record<string, string> = {
  gb: "GBP",
  us: "USD",
  de: "EUR",
  fr: "EUR",
  au: "AUD",
  ca: "CAD",
  pl: "PLN",
};
const BASE_URL = "https://api.adzuna.com/v1/api/jobs";

async function fetchCountry(country: string): Promise<Job[]> {
  const { data } = await axios.get(`${BASE_URL}/${country}/search/1`, {
    params: {
      app_id: config.adzunaAppId,
      app_key: config.adzunaAppKey,
      category: "it-jobs",
      what_exclude: "manager director vice president sales representative customer service recruiter accountant accounts payable finance specialist",
      max_days_old: 3,
      results_per_page: 50,
      sort_by: "date",
    },
    timeout: HTTP_TIMEOUT,
  });

  const { results } = ResponseSchema.parse(data);

  return results.map((j) => ({
    id: `adzuna-${country}-${j.id}`,
    title: stripHtml(j.title),
    company: j.company.display_name,
    location: j.location.display_name || "Remote",
    salary: formatSalaryRange(j.salary_min, j.salary_max, COUNTRY_CURRENCY[country] ?? "USD"),
    salaryMinUsd: country === "us" ? (j.salary_min ?? undefined) : undefined,
    description: j.description,
    url: j.redirect_url,
    source: "Adzuna",
    tags: j.category.tag ? [j.category.tag] : [],
    publishedAt: j.created || new Date().toISOString(),
  }));
}

export async function fetchAdzuna(): Promise<Job[]> {
  if (!config.adzunaAppId || !config.adzunaAppKey) return [];

  const jobs: Job[] = []; // sequential to stay within Adzuna's rate limit
  for (const country of COUNTRIES) {
    try {
      jobs.push(...(await fetchCountry(country)));
    } catch (err) {
      logError(`Adzuna [${country}]`, err);
    }
  }
  return jobs;
}
