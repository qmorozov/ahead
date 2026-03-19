import { InlineKeyboard, Keyboard } from "grammy";
import { JOB_TYPE_PRESETS } from "../lib/utils";
import { sources } from "../sources";

// ── Types ──────────────────────────────────────────────────────────────────

export type WizardStep =
  | "welcome"
  | "roles"
  | "technologies"
  | "seniority"
  | "jobTypes"
  | "workFormat"
  | "locations"
  | "salary"
  | "languages"
  | "excludes";

export interface WizardSession {
  step: WizardStep;
  messageId: number | null;
  chatId: string;
  createdAt: number;
  roles: Set<string>;
  technologies: string[]; // ordered — first N are primary
  seniority: Set<string>;
  jobTypes: Set<string>;
  workArrangement: Set<string>;
  locations: Set<string>;
  minSalaryUsd: number;
  acceptedLanguages: Set<string>;
  excludeKeywords: Set<string>;
}

export type ToggleField =
  | "roles"
  | "seniority"
  | "jobTypes"
  | "locations"
  | "acceptedLanguages"
  | "excludeKeywords";

export type ToggleFieldOrWA = ToggleField | "workArrangement";

// ── Presets ────────────────────────────────────────────────────────────────

export const ROLE_PRESETS = [
  "Frontend",
  "Backend",
  "Fullstack",
  "DevOps",
  "Mobile",
  "Data & ML",
  "Design",
  "Product",
  "QA",
];

export const WIZARD_TECH_PRESETS: Record<string, string[]> = {
  frontend: [
    "react",
    "vue",
    "angular",
    "typescript",
    "next.js",
    "svelte",
    "javascript",
    "tailwind",
    "redux",
    "graphql",
    "html",
    "css",
    "sass",
    "webpack",
    "vite",
  ],
  backend: [
    "node.js",
    "python",
    "go",
    "java",
    "rust",
    "ruby",
    "php",
    ".net",
    "c#",
    "postgresql",
    "mongodb",
    "redis",
    "elasticsearch",
    "django",
    "fastapi",
    "express",
    "spring",
    "laravel",
    "docker",
    "nginx",
    "rabbitmq",
    "kafka",
  ],
  devops: [
    "kubernetes",
    "terraform",
    "aws",
    "docker",
    "ci/cd",
    "linux",
    "ansible",
    "gcp",
    "azure",
    "nginx",
    "prometheus",
    "grafana",
    "jenkins",
    "helm",
  ],
  mobile: [
    "react native",
    "flutter",
    "swift",
    "kotlin",
    "dart",
    "typescript",
    "expo",
    "firebase",
    "swiftui",
    "android",
  ],
  "data & ml": [
    "python",
    "tensorflow",
    "pytorch",
    "sql",
    "spark",
    "pandas",
    "scikit-learn",
    "jupyter",
    "postgresql",
    "airflow",
    "kafka",
    "docker",
  ],
  design: ["figma", "sketch", "adobe xd", "storybook", "css", "tailwind"],
  product: ["jira", "analytics", "a/b testing", "sql", "amplitude", "mixpanel"],
  qa: ["selenium", "cypress", "jest", "playwright", "pytest", "docker", "postman"],
};

export const WIZARD_SENIORITY = ["Intern", "Junior", "Middle", "Senior", "Staff", "Lead", "Manager"];

export const WORK_FORMAT_PRESETS = ["Remote", "Hybrid", "Onsite"];

export const REMOTE_LOCATION_PRESETS = [
  "Anywhere",
  "Americas (UTC-8\u2026-3)",
  "Europe (UTC-1\u2026+3)",
  "Asia (UTC+5\u2026+9)",
];

export const REGION_COUNTRIES: Record<string, string[]> = {
  Americas: ["USA", "Canada", "Brazil", "Mexico", "Argentina"],
  Europe: ["Germany", "Netherlands", "UK", "Ireland", "Switzerland"],
  Asia: ["India", "Singapore", "Japan", "Israel", "South Korea"],
};

export const LOCATION_SETTINGS_PRESETS = [
  "Anywhere",
  "Americas",
  "Europe",
  "Asia",
  "USA",
  "Canada",
  "UK",
  "Germany",
  "Netherlands",
  "Ireland",
  "Switzerland",
  "India",
  "Singapore",
];

export const LANGUAGE_PRESETS = ["English", "Chinese", "Spanish", "German", "French"];

export const EXCLUDE_PRESETS = [
  "gambling",
  "crypto",
  "web3",
  "staffing",
  "defense",
  "adult",
  "blockchain",
];

export const ALL_SOURCE_NAMES = sources.map((s) => s.name);

export const PRIMARY_STACK_SIZE = 5;

export { JOB_TYPE_PRESETS };

// ── Step flow ──────────────────────────────────────────────────────────────

export const STEP_FLOW: Record<string, WizardStep | "finish"> = {
  roles: "technologies",
  technologies: "seniority",
  seniority: "jobTypes",
  jobTypes: "workFormat",
  workFormat: "locations",
  locations: "salary",
  salary: "languages",
  languages: "excludes",
  excludes: "finish",
};

export const STEP_BACK: Record<string, WizardStep> = {
  technologies: "roles",
  seniority: "technologies",
  jobTypes: "seniority",
  workFormat: "jobTypes",
  locations: "workFormat",
  salary: "locations",
  languages: "salary",
  excludes: "languages",
};

export const TOTAL_STEPS = 9;

export const WIZ_TOGGLE: Record<string, ToggleFieldOrWA> = {
  role: "roles",
  sen: "seniority",
  jt: "jobTypes",
  wf: "workArrangement",
  loc: "locations",
  lang: "acceptedLanguages",
  excl: "excludeKeywords",
};

// ── Pure helpers ────────────────────────────────────────────────────────────

export function getTechPresets(roles: Set<string>): string[] {
  const techs = new Set<string>();
  for (const role of roles) {
    const lower = role.toLowerCase();
    const keys = lower === "fullstack" ? ["frontend", "backend"] : [lower];
    for (const k of keys) for (const t of WIZARD_TECH_PRESETS[k] ?? []) techs.add(t);
  }
  return [...techs];
}

export function getSalaryPresets(locations: Set<string>): { label: string; value: number }[] {
  const locs = [...locations].map((l) => l.toLowerCase());
  const isUSA = locs.some((l) => /usa|us|united states|america|canada/.test(l));
  const isWesternEurope = locs.some((l) =>
    /uk|united kingdom|western europe|germany|netherlands|france|ireland|switzerland/.test(l),
  );
  const isEasternEurope = locs.some((l) =>
    /europe|ukraine|poland|romania|bulgaria|czech|hungary|serbia|croatia|baltics/.test(l),
  );
  const isAsia = locs.some((l) => /asia|india|philippines|vietnam|indonesia|malaysia/.test(l));
  const isLatAm = locs.some((l) => /latin|brazil|mexico|argentina|colombia|chile/.test(l));

  if (isUSA)
    return [
      { label: "$50k+", value: 50_000 },
      { label: "$80k+", value: 80_000 },
      { label: "$100k+", value: 100_000 },
      { label: "$120k+", value: 120_000 },
      { label: "$150k+", value: 150_000 },
      { label: "$200k+", value: 200_000 },
    ];
  if (isWesternEurope && !isEasternEurope)
    return [
      { label: "$30k+", value: 30_000 },
      { label: "$50k+", value: 50_000 },
      { label: "$70k+", value: 70_000 },
      { label: "$90k+", value: 90_000 },
      { label: "$120k+", value: 120_000 },
    ];
  if (isEasternEurope || isLatAm)
    return [
      { label: "$10k+", value: 10_000 },
      { label: "$15k+", value: 15_000 },
      { label: "$25k+", value: 25_000 },
      { label: "$40k+", value: 40_000 },
      { label: "$60k+", value: 60_000 },
      { label: "$80k+", value: 80_000 },
    ];
  if (isAsia)
    return [
      { label: "$10k+", value: 10_000 },
      { label: "$15k+", value: 15_000 },
      { label: "$25k+", value: 25_000 },
      { label: "$40k+", value: 40_000 },
      { label: "$60k+", value: 60_000 },
      { label: "$80k+", value: 80_000 },
    ];
  // Default / Anywhere
  return [
    { label: "Skip", value: 0 },
    { label: "$15k+", value: 15_000 },
    { label: "$30k+", value: 30_000 },
    { label: "$50k+", value: 50_000 },
    { label: "$80k+", value: 80_000 },
    { label: "$120k+", value: 120_000 },
    { label: "$200k+", value: 200_000 },
  ];
}

export function isRemoteOnly(wa: Set<string> | string[]): boolean {
  if (wa instanceof Set) return wa.size === 1 && wa.has("Remote");
  return wa.length === 1 && wa.includes("Remote");
}

export function replyKb(paused: boolean): Keyboard {
  return new Keyboard()
    .text("\u2699\ufe0f Settings")
    .text(paused ? "\u25b6 Resume" : "\u23f8 Pause")
    .row()
    .text("\ud83d\udcca Activity")
    .text("\ud83d\udd0c Sources")
    .resized();
}

export function toggleGrid(
  presets: string[],
  selected: Set<string>,
  prefix: string,
  perRow: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < presets.length; i += perRow) {
    for (const p of presets.slice(i, i + perRow))
      kb.text(selected.has(p) ? `\u2705 ${p}` : p, `wiz:${prefix}:${p}`);
    kb.row();
  }
  return kb;
}

export function stepLabel(step: WizardStep): string {
  const labels: Record<string, string> = {
    roles: `Step 1 of ${TOTAL_STEPS} \u00b7 Roles`,
    technologies: `Step 2 of ${TOTAL_STEPS} \u00b7 Technologies`,
    seniority: `Step 3 of ${TOTAL_STEPS} \u00b7 Level`,
    jobTypes: `Step 4 of ${TOTAL_STEPS} \u00b7 Job Type`,
    workFormat: `Step 5 of ${TOTAL_STEPS} \u00b7 Work Format`,
    locations: `Step 6 of ${TOTAL_STEPS} \u00b7 Location`,
    salary: `Step 7 of ${TOTAL_STEPS} \u00b7 Min Salary`,
    languages: `Step 8 of ${TOTAL_STEPS} \u00b7 Languages`,
    excludes: `Step 9 of ${TOTAL_STEPS} \u00b7 Exclude`,
  };
  return labels[step] ?? "";
}

export function setSelectedText(s: Set<string>): string {
  return s.size > 0 ? `\n\nSelected: ${[...s].join(", ")}` : "";
}

export function addNavButtons(kb: InlineKeyboard, step: WizardStep, hasSelection: boolean, isLast = false): void {
  if (STEP_BACK[step]) kb.text("\u2190 Back", "wiz:back");
  if (isLast) {
    kb.text("\u2705 Finish setup", "wiz:done");
  } else {
    kb.text("Skip \u2192", "wiz:skip");
    if (hasSelection) kb.text("Next \u2192", "wiz:done");
  }
}
