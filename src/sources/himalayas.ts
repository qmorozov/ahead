import axios from "axios";
import { z } from "zod";
import { Job } from "../types";
import { formatSalaryRange } from "../utils";

const JobSchema = z.object({
  guid: z.string().default(""),
  title: z.string().default(""),
  companyName: z.string().default(""),
  locationRestrictions: z.array(z.string()).default([]),
  minSalary: z.number().nullable().optional(),
  maxSalary: z.number().nullable().optional(),
  currency: z.string().optional(),
  applicationLink: z.string().default(""),
  categories: z.array(z.string()).default([]),
  description: z.string().optional(),
  seniority: z.array(z.string()).default([]),
  pubDate: z
    .union([z.string(), z.number()])
    .default("")
    .transform((v) =>
      typeof v === "number" ? new Date(v * 1000).toISOString() : v || new Date().toISOString(),
    ),
});

const ResponseSchema = z.object({
  jobs: z.array(JobSchema).default([]),
});

export async function fetchHimalayas(): Promise<Job[]> {
  const { data } = await axios.get("https://himalayas.app/jobs/api");
  const { jobs } = ResponseSchema.parse(data);

  return jobs.map((j) => {
    const location =
      j.locationRestrictions.length > 0 ? j.locationRestrictions.join(", ") : "Remote";

    return {
      id: j.guid,
      title: j.title,
      company: j.companyName,
      location,
      salary: formatSalaryRange(j.minSalary, j.maxSalary, j.currency),
      description: j.description,
      seniority: j.seniority[0] || undefined,
      url: j.applicationLink,
      source: "Himalayas",
      tags: j.categories,
      publishedAt: j.pubDate,
    };
  });
}
