import { z } from "zod";
import { Job } from "../types";
import { stripHtml } from "../lib/utils";
import { createATSBoardFetcher } from "./ats-board";

const JobSchema = z.object({
  id: z.number().transform(String),
  title: z.string().default(""),
  location: z.object({ name: z.string().nullish().transform((v) => v ?? "") }).default({ name: "" }),
  absolute_url: z.string().default(""),
  updated_at: z.string().default(""),
  first_published: z.string().nullish(),
  content: z.string().optional(),
});

const ResponseSchema = z.object({
  jobs: z.array(JobSchema).default([]),
});

export const fetchGreenhouse = createATSBoardFetcher({
  platform: "greenhouse",
  label: "Greenhouse",
  batchSize: 50,
  boardsPerCycle: 1500,
  buildUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
  requestParams: { content: "true" },
  parseJobs(data: unknown, slug: string): Job[] {
    const { jobs } = ResponseSchema.parse(data);
    return jobs.map((j) => ({
      id: `gh-${slug}-${j.id}`,
      title: j.title,
      company: slug,
      location: j.location.name || "Remote",
      description: j.content ? stripHtml(j.content) : undefined,
      url: j.absolute_url,
      source: "Greenhouse",
      tags: [],
      publishedAt: j.first_published || j.updated_at,
    }));
  },
});
