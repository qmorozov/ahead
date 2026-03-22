import { JOB_TYPE_PRESETS } from "../lib/utils";
import { sources } from "../sources";

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
  technologies: string[]; // ordered first N are primary
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

export const WIZARD_SENIORITY = [
  "Intern",
  "Junior",
  "Middle",
  "Senior",
  "Staff",
  "Lead",
  "Manager",
];

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

// when user selects an exclude preset, also add these paired terms
export const EXCLUDE_EXPANSIONS: Readonly<Record<string, string[]>> = {
  crypto: ["cryptocurrency"],
  web3: ["web 3"],
  gambling: ["betting", "casino", "igaming"],
};

export const ALL_SOURCE_NAMES = sources.map((s) => s.name);

export { JOB_TYPE_PRESETS };

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

export const TOTAL_STEPS = Object.keys(STEP_FLOW).length;

export const WIZ_TOGGLE: Record<string, ToggleFieldOrWA> = {
  role: "roles",
  sen: "seniority",
  jt: "jobTypes",
  wf: "workArrangement",
  loc: "locations",
  lang: "acceptedLanguages",
  excl: "excludeKeywords",
};

export const STEP_LABELS: Record<string, string> = {
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

const NORTH_AMERICA_RE = /usa|united states|america|canada/;
const WESTERN_EUROPE_RE = /uk|united kingdom|germany|netherlands|france|ireland|switzerland/;
const EASTERN_EUROPE_RE =
  /europe|ukraine|poland|romania|bulgaria|czech|hungary|serbia|croatia|baltics/;
const ASIA_RE = /asia|india|philippines|vietnam|indonesia|malaysia/;
const LATAM_RE = /latin|brazil|mexico|argentina|colombia|chile/;

type SalaryPreset = { label: string; value: number };

const SALARY_NORTH_AMERICA: SalaryPreset[] = [
  { label: "$50k+", value: 50_000 },
  { label: "$80k+", value: 80_000 },
  { label: "$100k+", value: 100_000 },
  { label: "$120k+", value: 120_000 },
  { label: "$150k+", value: 150_000 },
  { label: "$200k+", value: 200_000 },
];

const SALARY_WESTERN_EUROPE: SalaryPreset[] = [
  { label: "$30k+", value: 30_000 },
  { label: "$50k+", value: 50_000 },
  { label: "$70k+", value: 70_000 },
  { label: "$90k+", value: 90_000 },
  { label: "$120k+", value: 120_000 },
];

const SALARY_EMERGING: SalaryPreset[] = [
  { label: "$10k+", value: 10_000 },
  { label: "$15k+", value: 15_000 },
  { label: "$25k+", value: 25_000 },
  { label: "$40k+", value: 40_000 },
  { label: "$60k+", value: 60_000 },
  { label: "$80k+", value: 80_000 },
];

const SALARY_DEFAULT: SalaryPreset[] = [
  { label: "Skip", value: 0 },
  { label: "$15k+", value: 15_000 },
  { label: "$30k+", value: 30_000 },
  { label: "$50k+", value: 50_000 },
  { label: "$80k+", value: 80_000 },
  { label: "$120k+", value: 120_000 },
  { label: "$200k+", value: 200_000 },
];

export function getTechPresets(roles: Set<string>): string[] {
  const keys = [...roles].flatMap((r) => {
    const lower = r.toLowerCase();
    return lower === "fullstack" ? ["frontend", "backend"] : [lower];
  });
  const techs = new Set(keys.flatMap((k) => WIZARD_TECH_PRESETS[k] ?? []));
  return [...techs];
}

export function getSalaryPresets(locations: Iterable<string>): SalaryPreset[] {
  const locs = [...locations].map((l) => l.toLowerCase());
  const matchesRegion = (re: RegExp) => locs.some((l) => re.test(l));

  if (matchesRegion(NORTH_AMERICA_RE)) return SALARY_NORTH_AMERICA;
  if (matchesRegion(WESTERN_EUROPE_RE) && !matchesRegion(EASTERN_EUROPE_RE))
    return SALARY_WESTERN_EUROPE;
  if (matchesRegion(EASTERN_EUROPE_RE) || matchesRegion(LATAM_RE) || matchesRegion(ASIA_RE))
    return SALARY_EMERGING;
  return SALARY_DEFAULT;
}

export function isRemoteOnly(wa: Iterable<string>): boolean {
  const arr = [...wa];
  return arr.length === 1 && arr[0] === "Remote";
}
