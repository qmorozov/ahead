import axios from "axios";
import { z } from "zod";
import { HTTP_TIMEOUT } from "../config";
import { Job } from "../types";
import { normalizeJobType } from "../lib/utils";

const JobSchema = z.object({
  slug: z.string().default(""),
  title: z.string().default(""),
  company_name: z.string().default(""),
  remote: z.boolean().default(false),
  location: z.string().default(""),
  url: z.string().default(""),
  tags: z.array(z.string()).default([]),
  job_types: z.array(z.string()).default([]),
  description: z.string().optional(),
  created_at: z
    .number()
    .default(0)
    .transform((v) => (v ? new Date(v * 1000).toISOString() : new Date().toISOString())),
});

const ResponseSchema = z.object({
  data: z.array(JobSchema).default([]),
});

export async function fetchArbeitnow(): Promise<Job[]> {
  const { data } = await axios.get("https://arbeitnow.com/api/job-board-api", {
    timeout: HTTP_TIMEOUT,
  });
  const { data: jobs } = ResponseSchema.parse(data);

  return jobs.map((j) => ({
    id: j.slug,
    title: j.title,
    company: j.company_name,
    location: j.location || (j.remote ? "Remote" : "Unknown"),
    jobType: j.job_types[0] ? normalizeJobType(j.job_types[0]) : undefined,
    description: j.description,
    url: j.url,
    source: "Arbeitnow",
    tags: j.tags,
    publishedAt: j.created_at,
  }));
}
