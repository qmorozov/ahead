import { Job, ParsedJob } from "./types";
import { stripHtml, detectSeniority } from "./utils";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const posted = new Date(dateStr).getTime();
  if (isNaN(posted)) return "";

  const diffMs = now - posted;
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

const MAX_MESSAGE_LENGTH = 4096;

const CATEGORY_WORDS =
  /programming|jobs|remote|development|design|management|marketing|writing|devops & sysadmin/i;

function companyHtml(job: Job): string {
  const name = escapeHtml(job.company);
  return job.companyUrl ? `<a href="${escapeHtml(job.companyUrl)}">${name}</a>` : name;
}

function techTags(job: Job, parsed: ParsedJob | null, limit: number): string[] {
  return (
    parsed?.primaryTags?.slice(0, limit) ??
    job.tags
      .filter((t) => !CATEGORY_WORDS.test(t))
      .slice(0, limit)
      .map((t) => t.toLowerCase())
  );
}

export function formatDigestItem(index: number, job: Job, parsed: ParsedJob | null): string {
  const title = `<b>${index}.</b> <a href="${escapeHtml(job.url)}">${escapeHtml(job.title)}</a> — ${companyHtml(job)}`;

  const tags = techTags(job, parsed, 4);
  const salary = parsed?.salary || job.salary;

  const metaParts: string[] = [];
  if (tags.length > 0) metaParts.push(tags.join(", "));
  if (salary) metaParts.push(salary);

  const meta = metaParts.length > 0 ? `\n    ${escapeHtml(metaParts.join(" · "))}` : "";

  return title + meta;
}

export function formatDigest(items: string[], total: number): string {
  const header = `📋 <b>${total} new job${total === 1 ? "" : "s"} found</b>`;
  const footer = "\n\n<i>Tap a number to see details</i>";
  return header + "\n\n" + items.join("\n\n") + footer;
}

export function hasContent(parsed: ParsedJob): boolean {
  return (
    parsed.requirements.length > 0 ||
    parsed.niceToHave.length > 0 ||
    parsed.responsibilities.length > 0
  );
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

  const lines = [
    `<a href="${escapeHtml(job.url)}"><b>${escapeHtml(job.title)}</b></a>`,
    `@ ${companyHtml(job)}`,
    `\n🌍 ${escapeHtml(job.location)}`,
    level && `<b>Level:</b> ${escapeHtml(level)}`,
    salary && `<b>Salary:</b> ${escapeHtml(salary)}`,
    tags.length > 0 && `<b>Stack:</b> ${escapeHtml(tags.join(", "))}`,
  ];
  const headerText = lines.filter(Boolean).join("\n");
  const footer = ago ? `\n\n⚡ Posted ${ago}` : "";

  const separators = 6; // "\n\n" between header, description, footer
  const descBudget = MAX_MESSAGE_LENGTH - headerText.length - footer.length - separators;

  let description = "";
  if (descBudget > 200) {
    if (parsed && hasContent(parsed)) {
      const rendered = renderParsedDescription(parsed, descBudget);
      if (rendered) description = `\n\n${rendered}`;
    } else if (job.description) {
      const fallback = fallbackDescription(job.description, descBudget);
      if (fallback) description = `\n\n${fallback}`;
    }
  }

  return headerText + description + footer;
}
