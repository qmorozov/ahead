import { config } from "../config";

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(msg: string): void {
  console.log(`[${ts()}] [INFO] ${msg}`);
}

export function debug(msg: string): void {
  if (config.debug) console.log(`[${ts()}] [DEBUG] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[${ts()}] [WARN] ${msg}`);
}

export function logError(source: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[${ts()}] [ERROR] ${source}: ${detail}`);
}
