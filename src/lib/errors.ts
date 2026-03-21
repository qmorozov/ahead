import { log } from "./logger";

// Expected failure (network, API) - log message only
export function logOperationalError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  log(`[${context}] ${msg}`);
}

// Unexpected failure - log full stack trace
export function logUnexpectedError(context: string, error: unknown): void {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`[UNEXPECTED][${context}] ${msg}`);
}
