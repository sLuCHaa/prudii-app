import type { Account, Signature } from "../types";

export interface SignatureDraft {
  id: string | null;
  name: string;
  html: string;
  text: string;
  accountIds: string[];
}

type Assigned = Pick<Account, "id" | "signature_id">;

/** By name as the language orders it: SQLite's own comparison puts "Ärzte" after "Zebra". */
export function sortSignatures(signatures: Signature[], locale: string): Signature[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return [...signatures].sort((a, b) => collator.compare(a.name, b.name));
}

/** The editable copy of a stored signature; `null` gives the empty form for a new one. */
export function draftOf(signature: Signature | null, accounts: Assigned[]): SignatureDraft {
  if (!signature) return { id: null, name: "", html: "", text: "", accountIds: [] };
  return {
    id: signature.id,
    name: signature.name,
    html: signature.html,
    text: signature.text,
    accountIds: accounts.filter((a) => a.signature_id === signature.id).map((a) => a.id),
  };
}

export function isDraftDirty(draft: SignatureDraft, signature: Signature | null, accounts: Assigned[]): boolean {
  const stored = draftOf(signature, accounts);
  const sameAccounts =
    draft.accountIds.length === stored.accountIds.length && draft.accountIds.every((id) => stored.accountIds.includes(id));
  return draft.name !== stored.name || draft.html !== stored.html || draft.text !== stored.text || !sameAccounts;
}

/** The name of the different signature an account uses right now, for the hint next to its tick. */
export function usesOther(account: Pick<Account, "signature_id">, draftId: string | null, signatures: Signature[]): string | null {
  if (!account.signature_id || account.signature_id === draftId) return null;
  return signatures.find((s) => s.id === account.signature_id)?.name ?? null;
}
