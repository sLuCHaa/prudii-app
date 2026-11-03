import type { NewsletterOverview, NewsletterRow, TrackerReport } from "../types";

export function readShare(row: Pick<NewsletterRow, "count" | "read">): number {
  return row.count > 0 ? row.read / row.count : 0;
}

// Unknown domains are noise one by one; together they show how much tracking has no name.
export function companyBars(report: TrackerReport): Array<{ label: string; count: number; other: boolean }> {
  const bars = report.companies.filter((c) => c.known).map((c) => ({ label: c.name, count: c.count, other: false }));
  if (report.other_count > 0) bars.push({ label: "", count: report.other_count, other: true });
  return bars;
}

export function initials(name: string): string {
  const words = name.trim().split("@")[0].split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (name.includes("@")) return words[0][0].toUpperCase();
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

export function checkState(
  overview: NewsletterOverview | undefined,
  report: TrackerReport | undefined,
  scanning: boolean,
): "loading" | "empty" | "ready" {
  if (!overview || !report) return "loading";
  if (overview.rows.length === 0 && report.scanned_mails === 0 && !scanning) return "empty";
  return "ready";
}
