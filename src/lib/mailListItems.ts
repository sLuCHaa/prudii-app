import type { Mail } from "../types";
import { getDateGroup } from "./dateUtils";

export type ListItem =
  | { kind: "separator"; group: string; label: string; key: string }
  | { kind: "mail"; mail: Mail; mailIndex: number };

export function buildListItems(mails: Mail[], labels: Record<string, string>, showDateGroups: boolean): ListItem[] {
  const items: ListItem[] = [];
  const seen: Record<string, number> = {};
  let lastGroup = "";
  mails.forEach((mail, i) => {
    if (showDateGroups) {
      const group = getDateGroup(mail.date);
      if (group !== lastGroup) {
        lastGroup = group;
        seen[group] = (seen[group] ?? 0) + 1;
        const key = seen[group] === 1 ? `sep-${group}` : `sep-${group}-${seen[group]}`;
        items.push({ kind: "separator", group, label: labels[group] || group, key });
      }
    }
    items.push({ kind: "mail", mail, mailIndex: i });
  });
  return items;
}

export function rowEstimateFor(density: string | null): number {
  return density === "compact" ? 62 : density === "spacious" ? 82 : 70;
}
