import pRetry from "p-retry";
import { AxiosError } from "axios";
import { Job } from "../types";
import { log } from "../lib/logger";
import { warn } from "../lib/logger";
import { recordSourceSuccess, recordSourceFailure, getSourceHealth } from "../db";
import { fetchRemoteOK } from "./remoteok";
import { fetchRemotive } from "./remotive";
import { fetchJobicy } from "./jobicy";
import { fetchHimalayas } from "./himalayas";
import { fetchArbeitnow } from "./arbeitnow";
import { fetchWeWorkRemotely } from "./weworkremotely";
import { fetchDjinni } from "./djinni";
import { fetchTheMuse } from "./themuse";
import { fetchWorkingNomads } from "./workingnomads";
import { fetchRemoteFirstJobs } from "./remotefirstjobs";
import { fetchHN } from "./hn";
import { fetchAdzuna } from "./adzuna";
import { fetchGreenhouse } from "./greenhouse";
import { fetchLever } from "./lever";
import { fetchAshby } from "./ashby";
import { fetchSmartRecruiters } from "./smartrecruiters";

export interface JobSource {
  readonly name: string;
  fetch(): Promise<Job[]>;
}

export const sources: readonly JobSource[] = [
  { name: "RemoteOK", fetch: fetchRemoteOK },
  { name: "Remotive", fetch: fetchRemotive },
  { name: "Jobicy", fetch: fetchJobicy },
  { name: "Himalayas", fetch: fetchHimalayas },
  { name: "Arbeitnow", fetch: fetchArbeitnow },
  { name: "WeWorkRemotely", fetch: fetchWeWorkRemotely },
  { name: "Djinni", fetch: fetchDjinni },
  { name: "TheMuse", fetch: fetchTheMuse },
  { name: "WorkingNomads", fetch: fetchWorkingNomads },
  { name: "RemoteFirstJobs", fetch: fetchRemoteFirstJobs },
  { name: "HN", fetch: fetchHN },
  { name: "Adzuna", fetch: fetchAdzuna },
  { name: "Greenhouse", fetch: fetchGreenhouse },
  { name: "Lever", fetch: fetchLever },
  { name: "Ashby", fetch: fetchAshby },
  { name: "SmartRecruiters", fetch: fetchSmartRecruiters },
];

const disabledUntil = new Map<string, number>();
const consecutiveFailures = new Map<string, number>();
const lastGoodResults = new Map<string, { jobs: Job[]; fetchedAt: number }>();
const DISABLE_TRANSIENT_MS = 3 * 60 * 1000;
const DISABLE_PERMANENT_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 60 * 60 * 1000; // serve stale results up to 1h

function isSourceDisabled(name: string): boolean {
  const until = disabledUntil.get(name);
  if (!until) return false;
  if (Date.now() >= until) {
    disabledUntil.delete(name);
    return false;
  }
  return true;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status && [429, 503, 504, 408].includes(status)) return true;
    const code = error.code ?? "";
    if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].includes(code)) return true;
  }
  return false;
}

export async function fetchWithRetry(source: JobSource): Promise<Job[]> {
  if (isSourceDisabled(source.name)) return [];

  try {
    const jobs = await pRetry(() => source.fetch(), {
      retries: 3,
      minTimeout: 2000,
      maxTimeout: 10_000,
      onFailedAttempt: (error) => {
        log(`${source.name} attempt ${error.attemptNumber}/3 failed (${error.retriesLeft} left)`);
      },
    });
    consecutiveFailures.delete(source.name);
    disabledUntil.delete(source.name);
    if (jobs.length > 0) lastGoodResults.set(source.name, { jobs, fetchedAt: Date.now() });
    recordSourceSuccess(source.name, jobs.length);
    return jobs;
  } catch (error) {
    warn(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    const failures = (consecutiveFailures.get(source.name) ?? 0) + 1;
    consecutiveFailures.set(source.name, failures);
    recordSourceFailure(source.name);
    const health = getSourceHealth(source.name);
    if (health && health.fail_streak >= 3) {
      log(`Source ${source.name} has failed ${health.fail_streak} times in a row`);
    }

    const isMinor = failures < 3 && isTransientError(error);
    const disableMs = isMinor ? DISABLE_TRANSIENT_MS : DISABLE_PERMANENT_MS;
    disabledUntil.set(source.name, Date.now() + disableMs);

    const stale = lastGoodResults.get(source.name);
    if (stale && Date.now() - stale.fetchedAt < STALE_TTL_MS) {
      log(`${source.name} failed, serving ${stale.jobs.length} stale jobs (failure #${failures})`);
      return stale.jobs;
    }

    log(`${source.name} disabled for ${Math.round(disableMs / 60_000)}min (failure #${failures})`);
    return [];
  }
}
