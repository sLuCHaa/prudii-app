import type { NewsletterOverview, NewsletterRow, TrackerReport } from "../types";

export function readShare(row: Pick<NewsletterRow, "count" | "read">): number {
  return row.count > 0 ? row.read / row.count : 0;
}

// Everything outside the shown companies forms one bar, so the bars add up to the tile's total.
export function companyBars(report: TrackerReport): Array<{ label: string; count: number; other: boolean }> {
  const bars = report.companies.filter((c) => c.known).map((c) => ({ label: c.name, count: c.count, other: false }));
  if (report.other_count > 0) bars.push({ label: "", count: report.other_count, other: true });
  return bars;
}

// The same list can reach several accounts; with all accounts shown, each row says which one it acts on.
export function rowCaption(row: Pick<NewsletterRow, "address">, accountLabel: string | null): string {
  return [row.address, accountLabel].filter(Boolean).join(" · ");
}

export function initials(name: string): string {
  const isAddress = name.includes("@");
  const source = isAddress ? name.trim().split("@")[0] : name;
  const words = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = (word: string) => Array.from(word)[0].toLocaleUpperCase();
  return isAddress ? first(words[0]) : words.slice(0, 2).map(first).join("");
}

export function checkState(
  overview: NewsletterOverview | undefined,
  report: TrackerReport | undefined,
  scanning: boolean,
  failed = false,
): "loading" | "empty" | "ready" | "error" {
  if (failed) return "error";
  if (!overview || !report) return "loading";
  if (overview.rows.length === 0 && report.scanned_mails === 0 && !scanning) return "empty";
  return "ready";
}
