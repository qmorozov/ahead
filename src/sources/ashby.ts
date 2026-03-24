import { z } from "zod";
import { Job } from "../types";
import { normalizeJobType } from "../lib/utils";
import { createATSBoardFetcher } from "./ats-board";

const JobSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  location: z.string().default(""),
  isRemote: z.boolean().nullable().default(false),
  employmentType: z.string().default(""),
  descriptionPlain: z.string().optional(),
  publishedAt: z.string().default(""),
  jobUrl: z.string().default(""),
});

const ResponseSchema = z.object({
  jobs: z.array(JobSchema).default([]),
});

export const fetchAshby = createATSBoardFetcher({
  platform: "ashby",
  label: "Ashby",
  batchSize: 50,
  boardsPerCycle: 500,
  buildUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  requestParams: { includeCompensation: "true" },
  parseJobs(data: unknown, slug: string): Job[] {
    const { jobs } = ResponseSchema.parse(data);
    return jobs.map((j) => ({
      id: `ash-${slug}-${j.id}`,
      title: j.title,
      company: slug,
      location: j.location || (j.isRemote === true ? "Remote" : ""),
      jobType: normalizeJobType(j.employmentType),
      description: j.descriptionPlain,
      url: j.jobUrl,
      source: "Ashby",
      tags: [],
      publishedAt: j.publishedAt || new Date().toISOString(),
    }));
  },
});
