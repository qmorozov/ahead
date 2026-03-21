/**
 * Scoring weights for job relevance.
 * Units: points added to total score.
 * A job passes if its total score >= THRESHOLD (adjusted by computeThreshold).
 */
export const SCORING = {
  THRESHOLD: 20, // points - base pass threshold, raised dynamically for complex profiles
  TITLE_KEYWORD: 25, // points - user keyword found in job title
  TAG_KEYWORD: 15, // points - user keyword found in job tags
  ROLE_MATCH: 15, // points - job title matches user's target role
  SENIORITY_MATCH: 10, // points - job seniority matches user's level
  STRONG_STACK_FIT: 10, // points - bonus for high coverage + recall overlap
  TAG_OVERLAP_MAX: 30, // points - max score from weighted tag coverage/recall
  FRESHNESS_MAX: 5, // points - max bonus for recently posted jobs
  SALARY_MATCH: 5, // points - salary meets user's minimum
  HIGH_QUALITY_SOURCE: 3, // points - job from a curated source (Greenhouse, Lever, HN)
  COMPANY_SIZE: 3, // points - company has many board listings (established employer)
  DESC_KEYWORD_MAX: 15, // points - max score from keyword matches in description text
  ROLE_TECH_MAX: 10, // points - max bonus from role-domain tech matches in parsed tags
} as const;

/**
 * Score penalties. All values are negative.
 * Applied when a job has a disqualifying or undesirable trait.
 * Hard rejects (excluded tech, seniority mismatch, wrong role) return score -1 directly.
 */
export const PENALTY = {
  NO_ROLE: -15, // points - job title doesn't match any known role
  OVERQUALIFIED: -20, // points - job level is 2+ above user's max
  EXCLUDE_REQUIREMENT: -30, // points - excluded tech appears in requirements
  EXCLUDE_NICE: -10, // points - excluded tech appears in nice-to-have
  EXCLUDE_DESC: -15, // points - excluded tech appears in description
  STAFFING_AGENCY: -10, // points - company name matches staffing agency pattern
  LOW_QUALITY: -10, // points - missing 2+ of company/description/location
  FOREIGN_LANGUAGE: -15, // points - description detected as non-English
  FOREIGN_TECH: -15, // points - specialist tech in title user doesn't know (per occurrence)
  RELOCATION: -15, // points - description requires relocation
  ARRANGEMENT_MISMATCH: -20, // points - onsite job for a remote-seeking user
} as const;

/**
 * Stack overlap thresholds for hard-reject and scoring.
 * Controls when a job's tech stack is too different from the user's.
 */
export const STACK = {
  MIN_TAGS: 5, // count - minimum non-generic tags needed to evaluate overlap
  COVERAGE_THRESHOLD: 0.35, // ratio - job coverage below this + low recall = hard reject
  RECALL_THRESHOLD: 0.4, // ratio - user recall below this + low coverage = hard reject
  COVERAGE_WEIGHT: 0.6, // ratio - weight of job coverage in overlap score
  RECALL_WEIGHT: 0.4, // ratio - weight of user recall in overlap score
  STRONG_COVERAGE: 0.6, // ratio - job coverage above this = strong stack fit bonus
  STRONG_RECALL: 0.5, // ratio - user recall above this = strong stack fit bonus
} as const;

/**
 * Freshness decay parameters.
 * Newer jobs get a small score bonus that decays exponentially.
 */
export const FRESHNESS = {
  DECAY_HOURS: 48, // hours - half-life for freshness bonus decay
} as const;

/** Sources whose job listings come from curated company career pages. */
export const HIGH_QUALITY_SOURCES = new Set(["Greenhouse", "Lever", "HN"]);

/**
 * Polling cycle parameters.
 * Controls per-company caps, source caching, and company size heuristics.
 */
export const POLLING = {
  MAX_PER_COMPANY: 3, // count - max jobs sent per company per cycle
  SOURCE_CACHE_TTL_MS: 2 * 60 * 1000, // ms - reuse fetched sources within this window
  COMPANY_SIZE_MIN_JOBS: 10, // count — board job count threshold for "established" bonus
} as const;

/**
 * LLM usage limits and configuration.
 * Shared across Groq and Cerebras providers.
 */
export const LLM = {
  PARSES_PER_HOUR: 300, // count — max full parses per hour across all users
  QUOTA_COOLDOWN_MS: 60 * 60 * 1000, // ms — cooldown window for parse quota
  MAX_INPUT_CHARS: 2000, // chars — max description length sent to LLM
  CLASSIFY_BATCH_SIZE: 15, // count — jobs per LLM classify call
} as const;

/**
 * Wizard (onboarding flow) timeouts and limits.
 */
export const WIZARD = {
  TTL_MS: 30 * 60 * 1000, // ms — wizard session expires after 30min of inactivity
  INPUT_TTL_MS: 10 * 60 * 1000, // ms — free-text input prompt expires after 10min
  MAX_ARRAY_ITEMS: 50, // count — max items in any user settings array
  MAX_ITEM_LENGTH: 100, // chars — max length of a single settings item
} as const;

/**
 * Job delivery (message formatting) parameters.
 */
export const DELIVERY = {
  PAGE_SIZE: 7, // count — max jobs per digest message
  MAX_LENGTH: 4096, // chars — Telegram message length limit
} as const;
