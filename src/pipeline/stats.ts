/** A job that was filtered out, with its rejection reason for display in /status. */
export interface RejectedJob {
  title: string;
  company: string;
  url: string;
  reason: string;
}

/** Per-cycle poll stats, shown in /status. */
export interface UserPollStats {
  checked: number;
  passed: number;
  sent: number;
  rejected: RejectedJob[];
}

const pollStats = new Map<string, UserPollStats>();
const MAX_REJECTED = 10;

/** Get poll stats for a user, or undefined if no poll has run yet. */
export function getPollStats(chatId: string): UserPollStats | undefined {
  return pollStats.get(chatId);
}

/** Get or create a fresh stats object for a user. */
export function getOrCreateStats(chatId: string): UserPollStats {
  let stats = pollStats.get(chatId);
  if (!stats) {
    stats = { checked: 0, passed: 0, sent: 0, rejected: [] };
    pollStats.set(chatId, stats);
  }
  return stats;
}

/** Remove stats for users that are no longer active. */
export function clearPollStats(chatId: string): void {
  pollStats.delete(chatId);
}

export function pruneInactiveStats(activeIds: Set<string>): void {
  for (const id of pollStats.keys()) {
    if (!activeIds.has(id)) pollStats.delete(id);
  }
}

export function updatePollStats(
  stats: UserPollStats,
  checkedCount: number,
  passedCount: number,
  irrelevant: Array<{ key: string; title: string; company: string; url: string }>,
  signalsMap: Map<string, string[]>,
): void {
  stats.checked = checkedCount;
  stats.passed = passedCount;
  stats.sent = 0;
  stats.rejected = [];
  for (const nj of irrelevant) {
    const reasons = signalsMap.get(nj.key) ?? [];
    stats.rejected.push({
      title: nj.title,
      company: nj.company,
      url: nj.url,
      reason: reasons[0] ?? "low score",
    });
  }
  if (stats.rejected.length > MAX_REJECTED) {
    stats.rejected = stats.rejected.slice(-MAX_REJECTED);
  }
}
