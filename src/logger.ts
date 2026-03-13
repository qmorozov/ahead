function timestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

export function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

export function logError(source: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[${timestamp()}] [ERROR] ${source}: ${msg}`);
}
