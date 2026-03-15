import axios from "axios";
import { z } from "zod";
import { HTTP_TIMEOUT } from "../config";
import { Job } from "../types";
import { formatSalaryRange } from "../format";

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  position: z.string().default(""),
  company: z.string().default(""),
  location: z.string().default("Remote"),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  url: z.string().default(""),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  date: z.string().default(""),
});

export async function fetchRemoteOK(): Promise<Job[]> {
  const { data } = await axios.get("https://remoteok.com/api", {
    headers: { "User-Agent": "ahead-bot/1.0" },
    timeout: HTTP_TIMEOUT,
  });

  const raw = z.array(z.unknown()).parse(data);
  const jobs: Job[] = [];

  for (const item of raw.slice(1)) { // first element is API metadata, not a job
    const result = JobSchema.safeParse(item);
    if (!result.success) continue;
    const j = result.data;

    jobs.push({
      id: j.id,
      title: j.position,
      company: j.company,
      location: j.location,
      salary: formatSalaryRange(j.salary_min, j.salary_max, "$"),
      salaryMinUsd: j.salary_min || undefined,
      description: j.description,
      url: j.url.startsWith("http")
        ? j.url
        : `https://remoteok.com${j.url || `/remote-jobs/${j.id}`}`,
      source: "RemoteOK",
      tags: j.tags,
      publishedAt: j.date || new Date().toISOString(),
    });
  }

  return jobs;
}
