import axios from "axios";
import { z } from "zod";
import { Job } from "../types";

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  position: z.string().default(""),
  company: z.string().default(""),
  location: z.string().default("Remote"),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  url: z.string().default(""),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  date: z.string().default(""),
});

export async function fetchRemoteOK(): Promise<Job[]> {
  const { data } = await axios.get("https://remoteok.com/api", {
    headers: { "User-Agent": "ahead-bot/1.0" },
  });

  const raw = z.array(z.unknown()).parse(data);

  return raw.slice(1).flatMap((item) => {
    const result = JobSchema.safeParse(item);
    if (!result.success) return [];
    const j = result.data;

    let salary: string | undefined;
    if (j.salary_min && j.salary_max) {
      salary = `$${j.salary_min.toLocaleString()} – $${j.salary_max.toLocaleString()}`;
    }

    return [
      {
        id: j.id,
        title: j.position,
        company: j.company,
        location: j.location,
        salary,
        description: j.description,
        url: j.url.startsWith("http")
          ? j.url
          : `https://remoteok.com${j.url || `/remote-jobs/${j.id}`}`,
        source: "RemoteOK",
        tags: j.tags,
        publishedAt: j.date || new Date().toISOString(),
      },
    ];
  });
}
