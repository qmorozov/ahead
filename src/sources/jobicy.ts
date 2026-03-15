import axios from "axios";
import { z } from "zod";
import { HTTP_TIMEOUT } from "../config";
import { Job } from "../types";
import { formatSalaryRange } from "../format";

const JobSchema = z.object({
  id: z.number().transform(String),
  jobTitle: z.string().default(""),
  companyName: z.string().default(""),
  jobGeo: z.string().default("Remote"),
  annualSalaryMin: z.number().optional(),
  annualSalaryMax: z.number().optional(),
  salaryCurrency: z.string().optional(),
  url: z.string().default(""),
  jobIndustry: z.array(z.string()).default([]),
  jobDescription: z.string().optional(),
  jobExcerpt: z.string().optional(),
  pubDate: z.string().default(""),
});

const ResponseSchema = z.object({
  jobs: z.array(JobSchema).default([]),
});

export async function fetchJobicy(): Promise<Job[]> {
  const { data } = await axios.get("https://jobicy.com/api/v2/remote-jobs", {
    timeout: HTTP_TIMEOUT,
  });
  const { jobs } = ResponseSchema.parse(data);

  return jobs.map((j) => ({
    id: j.id,
    title: j.jobTitle,
    company: j.companyName,
    location: j.jobGeo,
    salary: formatSalaryRange(j.annualSalaryMin, j.annualSalaryMax, j.salaryCurrency),
    salaryMinUsd:
      j.salaryCurrency?.toUpperCase() === "USD" ? (j.annualSalaryMin ?? undefined) : undefined,
    description: j.jobDescription || j.jobExcerpt,
    url: j.url,
    source: "Jobicy",
    tags: j.jobIndustry,
    publishedAt: j.pubDate || new Date().toISOString(),
  }));
}
