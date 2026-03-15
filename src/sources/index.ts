import pRetry from "p-retry";
import { Job } from "../types";
import { log, logError } from "../logger";
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

interface Source {
  name: string;
  fetch: () => Promise<Job[]>;
}

export const sources: Source[] = [
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
];

const disabledUntil = new Map<string, number>();
const DISABLE_FOR_MS = 15 * 60 * 1000;

function isSourceDisabled(name: string): boolean {
  const until = disabledUntil.get(name);
  if (!until) return false;
  if (Date.now() >= until) {
    disabledUntil.delete(name);
    return false;
  }
  return true;
}

export async function fetchWithRetry(source: Source): Promise<Job[]> {
  if (isSourceDisabled(source.name)) return [];

  try {
    const jobs = await pRetry(() => source.fetch(), {
      retries: 3,
      minTimeout: 2000,
      onFailedAttempt: (error) => {
        log(`${source.name} attempt ${error.attemptNumber}/3 failed (${error.retriesLeft} left)`);
      },
    });
    disabledUntil.delete(source.name);
    return jobs;
  } catch (error) {
    logError(source.name, error);
    disabledUntil.set(source.name, Date.now() + DISABLE_FOR_MS);
    log(`${source.name} disabled for 15min`);
    return [];
  }
}
