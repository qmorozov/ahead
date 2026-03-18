import { z } from "zod";
import { Job } from "../types";
import { createATSBoardFetcher } from "./ats-board";

const JobSchema = z.object({
  id: z.string(),
  text: z.string().default(""),
  categories: z
    .object({
      commitment: z.string().optional(),
      department: z.string().optional(),
      location: z.string().optional(),
      team: z.string().optional(),
    })
    .default({}),
  hostedUrl: z.string().default(""),
  createdAt: z.number().transform((v) => new Date(v).toISOString()),
  descriptionPlain: z.string().optional(),
});

const ResponseSchema = z.array(JobSchema).default([]);

export const fetchLever = createATSBoardFetcher({
  platform: "lever",
  label: "Lever",
  batchSize: 40,
  boardsPerCycle: 1500,
  accept429: true,
  buildUrl: (slug) => `https://api.lever.co/v0/postings/${slug}`,
  parseJobs(data: unknown, slug: string): Job[] {
    const jobs = ResponseSchema.parse(data);
    return jobs.map((j) => ({
      id: `lv-${slug}-${j.id}`,
      title: j.text,
      company: slug,
      location: j.categories.location || "Remote",
      description: j.descriptionPlain,
      url: j.hostedUrl,
      source: "Lever",
      jobType: j.categories.commitment?.toLowerCase().includes("contract") ? "contract" : undefined,
      tags: [],
      publishedAt: j.createdAt,
    }));
  },
});