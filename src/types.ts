import { z } from "zod";

/** Zod schema for a normalized job listing. All sources must produce data conforming to this shape. */
export const JobSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  salary: z.string().optional(),
  description: z.string().optional(),
  seniority: z.string().optional(),
  jobType: z.string().optional(),
  salaryMinUsd: z.number().optional(),
  url: z.string(),
  source: z.string(),
  companyUrl: z.string().optional(),
  tags: z.array(z.string()),
  publishedAt: z.string(),
  boardJobCount: z.number().optional(),
});

/** A normalized job listing aggregated from any source. */
export type Job = z.infer<typeof JobSchema>;

const SeniorityEnum = z.enum(["Intern", "Junior", "Middle", "Senior", "Staff", "Lead", "Manager"]);

/** Zod schema for LLM-parsed job description data. */
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

/** Structured data extracted from a job description by the LLM pipeline. */
export type ParsedJob = z.infer<typeof ParsedJobSchema>;

/** Unique key for deduplication: `source::id`. */
export function jobKey(job: Job): string {
  return `${job.source.toLowerCase()}::${job.id}`;
}

/** Returns true if the parsed result has any meaningful content (not empty). */
export function hasContent(parsed: ParsedJob): boolean {
  return (
    parsed.requirements.length > 0 ||
    parsed.niceToHave.length > 0 ||
    parsed.responsibilities.length > 0 ||
    parsed.primaryTags.length > 0
  );
}
