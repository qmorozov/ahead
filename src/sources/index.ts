import axios from "axios";
import { Job } from "../types";
import { log, logError } from "../logger";
import { sleep } from "../utils";
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

axios.defaults.timeout = 15_000;

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

  const maxRetries = 3;
  const baseDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const jobs = await source.fetch();
      disabledUntil.delete(source.name);
      return jobs;
    } catch (error) {
      if (attempt === maxRetries) {
        logError(source.name, error);
        disabledUntil.set(source.name, Date.now() + DISABLE_FOR_MS);
        log(`${source.name} disabled for 15min`);
        return [];
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  return [];
}
