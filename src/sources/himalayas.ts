import axios from "axios";
import { z } from "zod";
import { Job } from "../types";

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
  pubDate: z.union([z.string(), z.number()]).default(""),
});

const ResponseSchema = z.object({
  jobs: z.array(JobSchema).default([]),
});

export async function fetchHimalayas(): Promise<Job[]> {
  const { data } = await axios.get("https://himalayas.app/jobs/api");
  const { jobs } = ResponseSchema.parse(data);

  return jobs.map((j) => {
    let salary: string | undefined;
    if (j.minSalary && j.maxSalary) {
      const curr = j.currency ?? "USD";
      salary = `${curr} ${j.minSalary.toLocaleString()} – ${j.maxSalary.toLocaleString()}`;
    }

    const location =
      j.locationRestrictions.length > 0 ? j.locationRestrictions.join(", ") : "Remote";

    const publishedAt =
      typeof j.pubDate === "number"
        ? new Date(j.pubDate * 1000).toISOString()
        : j.pubDate || new Date().toISOString();

    return {
      id: j.guid,
      title: j.title,
      company: j.companyName,
      location,
      salary,
      description: j.description,
      seniority: j.seniority[0] || undefined,
      url: j.applicationLink,
      source: "Himalayas",
      tags: j.categories,
      publishedAt,
    };
  });
}
