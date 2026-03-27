import { z } from "zod";
import { Job } from "../types";
import { normalizeJobType } from "../lib/utils";
import { normalizeSeniority } from "../lib/seniority";
import { createATSBoardFetcher } from "./ats-board";

const LocationSchema = z.object({
  city: z.string().default(""),
  region: z.string().default(""),
  country: z.string().default(""),
  remote: z.boolean().default(false),
  hybrid: z.boolean().default(false),
  fullLocation: z.string().default(""),
});

const LabeledSchema = z.object({ id: z.string().default(""), label: z.string().default("") });

const JobSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  uuid: z.string().default(""),
  company: z.object({ name: z.string().default(""), identifier: z.string().default("") }),
  releasedDate: z.string().default(""),
  location: LocationSchema.optional(),
  experienceLevel: LabeledSchema.optional(),
  typeOfEmployment: LabeledSchema.optional(),
  department: z.object({ label: z.string().default("") }).optional(),
});

const ResponseSchema = z.object({
  content: z.array(JobSchema).default([]),
});

function buildLocation(loc: z.infer<typeof LocationSchema>): string {
  if (loc.remote) return loc.fullLocation || "Remote";
  return loc.fullLocation || [loc.city, loc.country].filter(Boolean).join(", ") || "";
}

export const fetchSmartRecruiters = createATSBoardFetcher({
  platform: "smartrecruiters",
  label: "SmartRecruiters",
  batchSize: 30,
  boardsPerCycle: 200,
  buildUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
  requestParams: { limit: "100" },
  parseJobs(data: unknown, slug: string): Job[] {
    const { content } = ResponseSchema.parse(data);
    const defaultLoc = {
      city: "",
      region: "",
      country: "",
      remote: false,
      hybrid: false,
      fullLocation: "",
    };
    return content.map((j) => ({
      id: `sr-${slug}-${j.id}`,
      title: j.name,
      company: j.company.name || slug,
      location: buildLocation(j.location ?? defaultLoc),
      seniority: normalizeSeniority(j.experienceLevel?.id ?? null) ?? undefined,
      jobType: j.typeOfEmployment?.id ? normalizeJobType(j.typeOfEmployment.id) : undefined,
      url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      source: "SmartRecruiters",
      tags: [j.department?.label, j.experienceLevel?.label].filter((t): t is string => !!t),
      publishedAt: j.releasedDate || new Date().toISOString(),
    }));
  },
});
