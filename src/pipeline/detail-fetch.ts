import axios from "axios";
import { Job } from "../types";
import { stripHtml } from "../lib/utils";
import { debug } from "../lib/logger";

const TIMEOUT = 8_000;

export interface DetailResult {
  description: string;
  deadline?: string;
}

interface DetailConfig {
  urlPattern: RegExp;
  buildApiUrl: (groups: string[]) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any external API response, validated at call site
  extract: (data: any) => DetailResult | undefined;
}

const SOURCES: Record<string, DetailConfig> = {
  Workday: {
    urlPattern: /https:\/\/(\w+)\.(wd\d+)\.myworkdayjobs\.com\/en-US\/([^/]+)(\/job\/.+)/,
    buildApiUrl: ([, company, instance, portal, path]) =>
      `https://${company}.${instance}.myworkdayjobs.com/wday/cxs/${company}/${portal}${path}`,
    extract: (data) => {
      const info = data?.jobPostingInfo;
      const html = info?.jobDescription;
      if (!html) return undefined;
      return {
        description: html,
        deadline: info?.timeLeftToApply ?? undefined,
      };
    },
  },
  SmartRecruiters: {
    urlPattern: /jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/,
    buildApiUrl: ([, slug, id]) =>
      `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`,
    extract: (data) => {
      const s = data?.jobAd?.sections ?? {};
      const html = [s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text]
        .filter(Boolean)
        .join("\n");
      return html ? { description: html } : undefined;
    },
  },
};

export function needsDetailFetch(job: Job): boolean {
  return !job.description && job.source in SOURCES;
}

export async function fetchJobDetail(job: Job): Promise<DetailResult | null> {
  const config = SOURCES[job.source];
  if (!config) return null;

  const match = job.url.match(config.urlPattern);
  if (!match) return null;

  debug(`Detail fetch [${job.source}] ${job.company}`);
  try {
    const { data } = await axios.get(config.buildApiUrl([...match]), { timeout: TIMEOUT });
    const result = config.extract(data);
    if (!result) return null;
    return { description: stripHtml(result.description), deadline: result.deadline };
  } catch {
    return null;
  }
}
