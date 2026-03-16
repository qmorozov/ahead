import axios from "axios";
import { z } from "zod";
import { HTTP_TIMEOUT } from "../config";
import { Job } from "../types";
import { normalizeJobType } from "../utils";

const JobSchema = z.object({
  id: z.number().transform(String),
  title: z.string().default(""),
  company_name: z.string().default(""),
  candidate_required_location: z.string().default("Remote"),
  salary: z.string().default(""),
  job_type: z.string().default(""),
  url: z.string().default(""),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  publication_date: z.string().default(""),
});

const ResponseSchema = z.object({
  jobs: z.array(JobSchema).default([]),
});

export async function fetchRemotive(): Promise<Job[]> {
  const { data } = await axios.get("https://remotive.com/api/remote-jobs", { timeout: HTTP_TIMEOUT });
  const { jobs } = ResponseSchema.parse(data);

  return jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location,
    salary: j.salary || undefined,
    jobType: normalizeJobType(j.job_type),
    description: j.description,
    url: j.url,
    source: "Remotive",
    tags: j.tags,
    publishedAt: j.publication_date || new Date().toISOString(),
  }));
}
