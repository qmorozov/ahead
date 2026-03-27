import { z } from "zod";
import { Job } from "../types";
import { normalizeSeniority } from "../lib/seniority";
import { createATSBoardFetcher } from "./ats-board";

const JobSchema = z.object({
  title: z.string().default(""),
  externalPath: z.string().default(""),
  locationsText: z.string().default(""),
  postedOn: z.string().default(""),
  bulletFields: z.array(z.string()).default([]),
});

const ResponseSchema = z.object({
  total: z.number().default(0),
  jobPostings: z.array(JobSchema).default([]),
});

function parseSlug(slug: string): { company: string; instance: string; portal: string } | null {
  const parts = slug.split("|");
  if (parts.length < 3) return null;
  return { company: parts[0]!, instance: parts[1]!, portal: parts[2]! };
}

export const fetchWorkday = createATSBoardFetcher({
  platform: "workday",
  label: "Workday",
  batchSize: 20,
  boardsPerCycle: 500,
  buildUrl(slug: string): string {
    const p = parseSlug(slug);
    if (!p) return "";
    return `https://${p.company}.${p.instance}.myworkdayjobs.com/wday/cxs/${p.company}/${p.portal}/jobs`;
  },
  postBody: { limit: 20, offset: 0 },
  timeoutMs: 8000,
  parseJobs(data: unknown, slug: string): Job[] {
    const p = parseSlug(slug);
    if (!p) return [];
    const { jobPostings } = ResponseSchema.parse(data);
    const baseUrl = `https://${p.company}.${p.instance}.myworkdayjobs.com/en-US/${p.portal}`;

    return jobPostings.map((j) => {
      const refId = j.bulletFields[0] ?? j.externalPath.split("_").pop() ?? "";
      return {
        id: `wd-${p.company}-${refId || j.externalPath}`,
        title: j.title,
        company: p.company,
        location: j.locationsText || "",
        seniority: normalizeSeniority(j.title) ?? undefined,
        url: `${baseUrl}${j.externalPath}`,
        source: "Workday",
        tags: [],
        publishedAt: new Date().toISOString(),
      };
    });
  },
});
