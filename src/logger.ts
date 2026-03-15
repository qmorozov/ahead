function timestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const DEBUG = process.env["DEBUG"] === "1";

export function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

export function debug(message: string): void {
  if (DEBUG) console.log(`[${timestamp()}] [DEBUG] ${message}`);
}

export function logError(source: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : typeof error === "object" ? JSON.stringify(error) : String(error);
  console.error(`[${timestamp()}] [ERROR] ${source}: ${msg}`);
}
