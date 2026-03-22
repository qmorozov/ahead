import { log } from "./logger";

/** Log an expected failure (network, API) — message only, no stack. */
export function logOperationalError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  log(`[${context}] ${msg}`);
}

/** Log an unexpected failure — full stack trace. */
export function logUnexpectedError(context: string, error: unknown): void {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`[UNEXPECTED][${context}] ${msg}`);
}
