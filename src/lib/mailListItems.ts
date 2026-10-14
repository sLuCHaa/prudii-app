import type { Mail } from "../types";
import { getDateGroup } from "./dateUtils";

export type ListItem =
  | { kind: "separator"; group: string; label: string }
  | { kind: "mail"; mail: Mail; mailIndex: number };

export function buildListItems(mails: Mail[], labels: Record<string, string>, showDateGroups: boolean): ListItem[] {
  const items: ListItem[] = [];
  let lastGroup = "";
  mails.forEach((mail, i) => {
    if (showDateGroups) {
      const group = getDateGroup(mail.date);
      if (group !== lastGroup) {
        lastGroup = group;
        items.push({ kind: "separator", group, label: labels[group] || group });
      }
    }
    items.push({ kind: "mail", mail, mailIndex: i });
  });
  return items;
}
