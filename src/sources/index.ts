import axios from "axios";
import { Job } from "../types";
import { logError } from "../logger";
import { sleep } from "../utils";
import { fetchRemoteOK } from "./remoteok";
import { fetchRemotive } from "./remotive";
import { fetchJobicy } from "./jobicy";
import { fetchHimalayas } from "./himalayas";
import { fetchArbeitnow } from "./arbeitnow";
import { fetchWeWorkRemotely } from "./weworkremotely";

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
];

export async function fetchWithRetry(source: Source): Promise<Job[]> {
  const maxRetries = 3;
  const baseDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await source.fetch();
    } catch (error) {
      if (attempt === maxRetries) {
        logError(source.name, error);
        return [];
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  return [];
}
