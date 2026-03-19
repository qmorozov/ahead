import { z } from "zod";

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  description?: string;
  seniority?: string;
  jobType?: string;
  salaryMinUsd?: number;
  url: string;
  source: string;
  companyUrl?: string;
  tags: string[];
  publishedAt: string;
  boardJobCount?: number;
}

const SeniorityEnum = z.enum(["Intern", "Junior", "Middle", "Senior", "Staff", "Lead", "Manager"]);

export const ParsedJobSchema = z.object({
  requirements: z.array(z.string()),
  niceToHave: z.array(z.string()),
  responsibilities: z.array(z.string()),
  seniority: SeniorityEnum.nullable().catch(null),
  salary: z.string().nullable(),
  primaryTags: z.array(z.string()),
  workArrangement: z.enum(["remote", "hybrid", "onsite"]).nullable().catch(null),
  locationRestriction: z.string().max(100).nullable().catch(null),
});

export type ParsedJob = z.infer<typeof ParsedJobSchema>;

export function jobKey(job: Job): string {
  return `${job.source.toLowerCase()}::${job.id}`;
}

export function hasContent(parsed: ParsedJob): boolean {
  return (
    parsed.requirements.length > 0 ||
    parsed.niceToHave.length > 0 ||
    parsed.responsibilities.length > 0 ||
    parsed.primaryTags.length > 0
  );
}
