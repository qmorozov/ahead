import { Job, ParsedJob, hasContent } from "../types";
import { UserSettings } from "../db";
import { stripHtml, detectSeniority } from "../lib/utils";
import { DELIVERY } from "../constants";

export function formatSettings(settings: UserSettings): string {
  const fmt = (arr: string[], fallback: string) => (arr.length > 0 ? arr.join(", ") : fallback);

  const salary = settings.minSalaryUsd > 0 ? `$${settings.minSalaryUsd / 1000}k+` : "any";

  return [
    `Status \u00b7 ${settings.paused ? "paused" : "active"}`,
    `Roles \u00b7 ${fmt(settings.roles, "\u2014")}`,
    `Technologies \u00b7 ${fmt(settings.keywords, "\u2014")}`,
    `Exclude \u00b7 ${fmt(settings.excludeKeywords, "\u2014")}`,
    `Locations \u00b7 ${fmt(settings.locations, "any")}`,
    `Seniority \u00b7 ${fmt(settings.seniority, "any")}`,
    `Job type \u00b7 ${fmt(settings.jobTypes, "any")}`,
    `Min salary \u00b7 ${salary}`,
    `Interval \u00b7 ${settings.checkIntervalMinutes}min`,
    `Max age \u00b7 ${settings.maxJobAgeDays > 0 ? `${settings.maxJobAgeDays}d` : "off"}`,
    `Jobs sent \u00b7 ${settings.jobsSent}`,
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeUrl(url: string): boolean {
  try {
    const p = new URL(url);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const posted = new Date(dateStr).getTime();
  if (isNaN(posted)) return "";

  const diffMs = now - posted;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 2) return "just now";
  if (minutes < 60) return `about ${minutes} minutes ago`;
  if (hours === 1) return "about 1 hour ago";
  if (hours < 24) return `about ${hours} hours ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `about ${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "about 1 week ago";
  return `about ${weeks} weeks ago`;
}

const CATEGORY_WORDS =
  /programming|jobs|remote|development|design|management|marketing|writing|devops & sysadmin/i;

function companyHtml(job: Job): string {
  const name = escapeHtml(job.company);
  return job.companyUrl && isSafeUrl(job.companyUrl)
    ? `<a href="${escapeHtml(job.companyUrl)}">${name}</a>`
    : name;
}

function techTags(job: Job, parsed: ParsedJob | null, limit: number): string[] {
  if (parsed?.primaryTags && parsed.primaryTags.length > 0) {
    return parsed.primaryTags.slice(0, limit);
  }
  return job.tags
    .filter((t) => !CATEGORY_WORDS.test(t))
    .slice(0, limit)
    .map((t) => t.toLowerCase());
}

export function formatDigestItem(index: number, job: Job, parsed: ParsedJob | null, signals?: string[]): string {
  const company = job.company ? ` — ${companyHtml(job)}` : "";
  const url = isSafeUrl(job.url) ? escapeHtml(job.url) : "";
  const title = url
    ? `<b>${index}.</b> <a href="${url}">${escapeHtml(job.title)}</a>${company}`
    : `<b>${index}.</b> ${escapeHtml(job.title)}${company}`;

  const tags = techTags(job, parsed, 4);
  const salary = parsed?.salary || job.salary;

  const metaParts: string[] = [];
  if (tags.length > 0) metaParts.push(tags.join(", "));
  if (salary) metaParts.push(salary);

  const meta = metaParts.length > 0 ? `\n    ${escapeHtml(metaParts.join(" \u00b7 "))}` : "";
  const why = signals && signals.length > 0 ? `\n    \u2713 ${escapeHtml(signals.join(" \u00b7 "))}` : "";

  return title + meta + why;
}

export function formatDigest(items: string[], total: number): string {
  const header = `📋 <b>${total} new job${total === 1 ? "" : "s"} found</b>`;
  const footer = "\n\n<i>Tap a number to see details</i>";
  return header + "\n\n" + items.join("\n\n") + footer;
}

function renderParsedDescription(parsed: ParsedJob, budget: number): string {
  const sections = [
    { label: "Requirements", items: parsed.requirements },
    { label: "Responsibilities", items: parsed.responsibilities },
    { label: "Nice to Have", items: parsed.niceToHave },
  ];

  let text = "";
  for (const { label, items } of sections) {
    if (items.length === 0) continue;
    const section = `<b>${label}</b>\n${items.map((r) => `• ${escapeHtml(r)}`).join("\n")}`;
    if (text.length + section.length + 2 > budget) break;
    text += (text ? "\n\n" : "") + section;
  }
  return text;
}

function fallbackDescription(html: string, budget: number): string {
  const plain = escapeHtml(stripHtml(html));
  const limit = Math.min(600, budget);
  if (plain.length <= limit) return plain;
  let trimmed = plain.substring(0, limit);
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace > limit * 0.5) trimmed = trimmed.substring(0, lastSpace);
  return trimmed + "...";
}

export function formatMessage(job: Job, parsed: ParsedJob | null): string {
  const level = parsed?.seniority || job.seniority || detectSeniority(job.title);
  const salary = parsed?.salary || job.salary;
  const tags = techTags(job, parsed, 5);
  const ago = timeAgo(job.publishedAt);

  const titleUrl = isSafeUrl(job.url) ? escapeHtml(job.url) : "";
  const lines = [
    titleUrl ? `<a href="${titleUrl}"><b>${escapeHtml(job.title)}</b></a>` : `<b>${escapeHtml(job.title)}</b>`,
    job.company && `@ ${companyHtml(job)}`,
    job.location && `\n🌍 ${escapeHtml(job.location)}`,
    level && `<b>Level:</b> ${escapeHtml(level)}`,
    salary && `<b>Salary:</b> ${escapeHtml(salary)}`,
    tags.length > 0 && `<b>Stack:</b> ${escapeHtml(tags.join(", "))}`,
  ];
  const headerText = lines.filter(Boolean).join("\n");
  const footer = ago ? `\n\n⚡ Posted ${ago}` : "";

  const descBudget = DELIVERY.MAX_LENGTH - headerText.length - footer.length - "\n\n".length;

  let description = "";
  if (descBudget > 200) {
    const rendered = parsed && hasContent(parsed) ? renderParsedDescription(parsed, descBudget) : "";
    const desc = rendered || (job.description ? fallbackDescription(job.description, descBudget) : "");
    if (desc) description = `\n\n${desc}`;
  }

  const message = headerText + description + footer;
  if (message.length > DELIVERY.MAX_LENGTH) {
    // Drop description to avoid cutting HTML tags
    return (headerText + footer).substring(0, DELIVERY.MAX_LENGTH);
  }
  return message;
}
