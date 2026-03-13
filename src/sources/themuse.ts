import axios from "axios";
import { z } from "zod";
import { Job } from "../types";

const NamedSchema = z.object({ name: z.string().default("") });

const JobSchema = z.object({
  id: z.number().transform(String),
  name: z.string().default(""),
  contents: z.string().optional(),
  publication_date: z.string().default(""),
  company: NamedSchema.default({ name: "" }),
  locations: z.array(NamedSchema).default([]),
  levels: z.array(NamedSchema).default([]),
  categories: z.array(NamedSchema).default([]),
  tags: z.array(z.string()).default([]),
  refs: z.object({ landing_page: z.string().default("") }).default({ landing_page: "" }),
});

const ResponseSchema = z.object({
  results: z.array(JobSchema).default([]),
});

export async function fetchTheMuse(): Promise<Job[]> {
  const { data } = await axios.get(
    "https://www.themuse.com/api/public/jobs?page=0&descending=true",
  );
  const { results } = ResponseSchema.parse(data);

  return results.map((j) => {
    const location = j.locations.map((l) => l.name).join(", ") || "Remote";

    return {
      id: j.id,
      title: j.name,
      company: j.company.name,
      location,
      description: j.contents,
      seniority: j.levels[0]?.name || undefined,
      url: j.refs.landing_page,
      source: "TheMuse",
      tags: [...j.categories.map((c) => c.name), ...j.tags],
      publishedAt: j.publication_date || new Date().toISOString(),
    };
  });
}
