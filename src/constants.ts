export const THIRTY_DAYS_S = 2_592_000; // seconds in 30 days

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
  DESC_KEYWORD_MAX: 8, // points - max score from keyword matches in description text
  ROLE_TECH_MAX: 10, // points - max bonus from role-domain tech matches in parsed tags
} as const;

export const PENALTY = {
  NO_ROLE: -15, // points - job title doesn't match any known role
  OVERQUALIFIED: -20, // points - job level is 2+ above user's max
  EXCLUDE_REQUIREMENT: -30, // points - excluded tech appears in requirements
  EXCLUDE_NICE: -10, // points - excluded tech appears in nice-to-have
  EXCLUDE_DESC: -15, // points - excluded tech appears in description
  STAFFING_AGENCY: -10, // points - company name matches staffing agency pattern
  LOW_QUALITY: -10, // points - missing 2+ of company/description/location
  FOREIGN_LANGUAGE: -15, // points - description detected as non-English
  FOREIGN_TECH: -10, // points - specialist tech in title user doesn't know (per occurrence)
  RELOCATION: -15, // points - description requires relocation
} as const;

export const STACK = {
  MIN_TAGS: 5, // count - minimum non-generic tags needed to evaluate overlap
  COVERAGE_THRESHOLD: 0.35, // ratio - job coverage below this + low recall = hard reject
  RECALL_THRESHOLD: 0.4, // ratio - user recall below this + low coverage = hard reject
  COVERAGE_WEIGHT: 0.6, // ratio - weight of job coverage in overlap score
  RECALL_WEIGHT: 0.4, // ratio - weight of user recall in overlap score
  STRONG_COVERAGE: 0.6, // ratio - job coverage above this = strong stack fit bonus
  STRONG_RECALL: 0.5, // ratio - user recall above this = strong stack fit bonus
} as const;

export const FRESHNESS = {
  DECAY_HOURS: 48, // hours - half-life for freshness bonus decay
} as const;

export const HIGH_QUALITY_SOURCES = new Set(["Greenhouse", "Lever", "HN"]);

export const POLLING = {
  MAX_PER_COMPANY: 3, // count - max jobs sent per company per cycle
  SOURCE_CACHE_TTL_MS: 2 * 60 * 1000, // ms - reuse fetched sources within this window
  COMPANY_SIZE_MIN_JOBS: 10, // count - board job count threshold for "established" bonus
  MIN_INTERVAL_MINUTES: 10, // min - minimum user polling interval
  MAX_INTERVAL_MINUTES: 1440, // min - maximum user polling interval (24h)
  MAX_NEW_PER_CYCLE: 100, // count - cap new jobs per user per cycle to prevent timeouts
  MAX_DEFER_CYCLES: 3, // count - max cycles to defer unparsed irrelevant jobs before discarding
  DEFER_TTL_MS: 24 * 60 * 60 * 1000, // ms - deferred jobs expire after 24h
  USER_CONCURRENCY: 3, // count - max users processed in parallel per poll cycle
  PER_USER_TIMEOUT_MS: 300_000, // ms - timeout per user in a poll cycle (5min)
} as const;

export const LLM = {
  PARSES_PER_HOUR: 300, // count - max full parses per hour across all users
  QUOTA_COOLDOWN_MS: 60 * 60 * 1000, // ms - cooldown window for parse quota
  MAX_INPUT_CHARS: 2000, // chars - max description length sent to LLM
  CLASSIFY_BATCH_SIZE: 15, // count - jobs per LLM classify call
  MAX_PARSE_ATTEMPTS: 2, // count - retry LLM parse on validation failure
  MIN_DESCRIPTION_LENGTH: 50, // chars - skip LLM if description is shorter
  PARSE_CONCURRENCY: 3, // count - parallel LLM parse workers
} as const;

export const WIZARD = {
  TTL_MS: 30 * 60 * 1000, // ms - wizard session expires after 30min of inactivity
  INPUT_TTL_MS: 10 * 60 * 1000, // ms - free-text input prompt expires after 10min
  MAX_ARRAY_ITEMS: 50, // count - max items in any user settings array
  MAX_ITEM_LENGTH: 100, // chars - max length of a single settings item
} as const;

export const FEEDBACK = {
  AVOID_PENALTY: -5, // points - penalty per avoided tag found in job
  PREFER_BONUS: 3, // points - bonus per preferred tag found in job
} as const;

export const DELIVERY = {
  PAGE_SIZE: 7, // count - max jobs per digest message
  MAX_LENGTH: 4096, // chars - Telegram message length limit
  STORE_TTL_MS: 24 * 60 * 60 * 1000, // ms - pending job store expiry (24h)
  MAX_PENDING: 500, // count - max pending jobs in memory
  MAX_SEND_RETRIES: 2, // count - Telegram send retries before giving up
  RETRY_DELAY_MS: 2_000, // ms - delay between Telegram send retries
  MAX_TITLE_LEN: 40, // chars - truncate job title in activity view
} as const;
