import { ParsedJob } from "../../types";
import { SENIORITY_PATTERNS } from "../../lib/seniority";

export function matchesSeniority(
  title: string,
  parsed: ParsedJob | null,
  allowed: Set<string>,
): "match" | "title_mismatch" | "parsed_mismatch" | "unknown" {
  if (allowed.size === 0) return "match";

  let titleDetected = false;
  let titleMatch = false;
  for (const [label, re] of SENIORITY_PATTERNS) {
    if (re.test(title)) {
      titleDetected = true;
      if (allowed.has(label.toLowerCase())) titleMatch = true;
    }
  }

  // Title seniority is high-confidence — hard reject on mismatch
  if (titleDetected && !titleMatch) return "title_mismatch";
  if (titleMatch) return "match";
  // LLM-extracted seniority is lower confidence — soft penalty, not hard reject
  if (parsed?.seniority && !allowed.has(parsed.seniority.toLowerCase())) return "parsed_mismatch";
  return parsed?.seniority ? "match" : "unknown";
}

export function seniorityDetected(title: string, parsed: ParsedJob | null): boolean {
  if (parsed?.seniority) return true;
  return SENIORITY_PATTERNS.some(([, re]) => re.test(title));
}
