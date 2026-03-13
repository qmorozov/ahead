import axios from "axios";
import { z } from "zod";
import { Job } from "../types";

const JobSchema = z.object({
  url: z.string().default(""),
  title: z.string().default(""),
  description: z.string().optional(),
  company_name: z.string().default(""),
  category_name: z.string().default(""),
  tags: z.string().default(""),
  location: z.string().default("Remote"),
  pub_date: z.string().default(""),
});

const ResponseSchema = z.array(JobSchema).default([]);

export async function fetchWorkingNomads(): Promise<Job[]> {
  const { data } = await axios.get("https://www.workingnomads.com/api/exposed_jobs/");
  const jobs = ResponseSchema.parse(data);

  return jobs.map((j) => {
    const tags = j.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const lowerTags = new Set(tags.map((t) => t.toLowerCase()));
    if (j.category_name && !lowerTags.has(j.category_name.toLowerCase())) {
      tags.unshift(j.category_name);
    }

    return {
      id: j.url.match(/\/(\d+)\/?$/)?.[1] ?? j.url,
      title: j.title,
      company: j.company_name,
      location: j.location || "Remote",
      description: j.description,
      url: j.url,
      source: "WorkingNomads",
      tags,
      publishedAt: j.pub_date || new Date().toISOString(),
    };
  });
}
