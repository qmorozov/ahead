import { ParsedJob } from "../../types";
import { SENIORITY_PATTERNS } from "../../lib/utils";

export function matchesSeniority(
  title: string,
  parsed: ParsedJob | null,
  allowed: Set<string>,
): boolean {
  if (allowed.size === 0) return true;

  let titleDetected = false;
  let titleMatch = false;
  for (const [label, re] of SENIORITY_PATTERNS) {
    if (re.test(title)) {
      titleDetected = true;
      if (allowed.has(label.toLowerCase())) titleMatch = true;
    }
  }

  if (titleDetected && !titleMatch) return false;
  if (titleMatch) return true;
  if (parsed?.seniority) return allowed.has(parsed.seniority.toLowerCase());
  return true;
}

export function seniorityDetected(title: string, parsed: ParsedJob | null): boolean {
  if (parsed?.seniority) return true;
  return SENIORITY_PATTERNS.some(([, re]) => re.test(title));
}
