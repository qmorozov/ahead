import { log } from "./logger";

export function logOperationalError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  log(`[${context}] ${msg}`);
}

export function logUnexpectedError(context: string, error: unknown): void {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`[UNEXPECTED][${context}] ${msg}`);
}
