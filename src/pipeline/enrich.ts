import { Job } from "../types";
import { fetchDjinniEnrichment } from "../sources/djinni";
import { resolveCompanyUrls } from "./company";
import { sleep } from "../lib/utils";

interface Enrichable {
  job: Job;
}

async function enrichDjinniJobs(items: Enrichable[]): Promise<void> {
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5);
    const results = await Promise.all(batch.map((nj) => fetchDjinniEnrichment(nj.job.url)));
    for (let j = 0; j < batch.length; j++) {
      const enriched = results[j];
      const nj = batch[j];
      if (!enriched || !nj) continue;
      if (!nj.job.company && enriched.company) nj.job.company = enriched.company;
      if (!nj.job.location && enriched.location) nj.job.location = enriched.location;
    }
    if (i + 5 < items.length) await sleep(2000);
  }
}

function applyCompanyUrls(items: Enrichable[], urls: Map<string, string>): void {
  for (const { job } of items) {
    if (!job.companyUrl && job.company) {
      const url = urls.get(job.company.toLowerCase().trim());
      if (url) job.companyUrl = url;
    }
  }
}

export async function enrichJobs(items: Enrichable[]): Promise<void> {
  const djinniJobs = items.filter(
    (nj) => nj.job.source === "Djinni" && (!nj.job.company || !nj.job.location),
  );

  const [, companyUrls] = await Promise.all([
    djinniJobs.length > 0 ? enrichDjinniJobs(djinniJobs) : Promise.resolve(),
    resolveCompanyUrls(items.map((nj) => nj.job)),
  ]);
  applyCompanyUrls(items, companyUrls);

  const newlyNamed = djinniJobs.filter((nj) => nj.job.company && !nj.job.companyUrl);
  if (newlyNamed.length > 0) {
    const extraUrls = await resolveCompanyUrls(newlyNamed.map((nj) => nj.job));
    applyCompanyUrls(newlyNamed, extraUrls);
  }
}
