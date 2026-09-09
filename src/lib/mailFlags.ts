import type { MailFlag } from "../types";

/** Display order of the flag colours, shared by the picker and the context menu. */
export const FLAG_ORDER: MailFlag[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

/**
 * Flags carried by *every* mail in a selection — the ones a bulk menu can show
 * as checked. Returned in FLAG_ORDER so the menu never reorders itself.
 */
export function commonFlags(flagsPerMail: string[][]): MailFlag[] {
  if (flagsPerMail.length === 0) return [];
  return FLAG_ORDER.filter((flag) => flagsPerMail.every((flags) => flags.includes(flag)));
}

/**
 * What picking `flag` should do to a whole selection: a flag they all carry is
 * removed, anything else is added to all of them. Mirrors the single-mail
 * toggle, so one item in the menu covers both directions.
 */
export function bulkFlagAction(flagsPerMail: string[][], flag: MailFlag): "set" | "clear" {
  return commonFlags(flagsPerMail).includes(flag) ? "clear" : "set";
}
