import type { Mail } from "../../types";
import type { ComposeMode } from "./ComposeModal";

// Build the RFC 5322 References chain for a reply: the original's References
// header (full ancestry) followed by the original's own Message-ID.
function buildReferencesChain(mail: Mail | null | undefined): string | undefined {
  if (!mail?.message_id) return undefined;
  const prior = (mail.references || mail.in_reply_to || "").trim();
  const chain = prior ? `${prior} ${mail.message_id}` : mail.message_id;
  const seen = new Set<string>();
  const ids = chain.split(/\s+/).filter((id) => id && !seen.has(id) && seen.add(id));
  return ids.join(" ") || undefined;
}

/** A reopened draft carries the threading it was saved with — pointing at the draft itself would thread the sent mail under its own draft. */
export function threadingHeaders(mode: ComposeMode, mail: Mail | null | undefined): { in_reply_to?: string; references?: string } {
  if (mode === "draft") {
    return {
      in_reply_to: mail?.in_reply_to || undefined,
      references: mail?.references?.trim() || mail?.in_reply_to || undefined,
    };
  }
  return { in_reply_to: mail?.message_id || undefined, references: buildReferencesChain(mail) };
}
