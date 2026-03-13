import { z } from "zod";

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  description?: string;
  seniority?: string;
  url: string;
  source: string;
  companyUrl?: string;
  tags: string[];
  publishedAt: string;
}

export const ParsedJobSchema = z.object({
  requirements: z.array(z.string()),
  niceToHave: z.array(z.string()),
  responsibilities: z.array(z.string()),
  seniority: z.string().nullable(),
  salary: z.string().nullable(),
  primaryTags: z.array(z.string()),
});

export type ParsedJob = z.infer<typeof ParsedJobSchema>;
