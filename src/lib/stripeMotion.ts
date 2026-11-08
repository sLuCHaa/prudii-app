export interface StripeState {
  unread: boolean;
  starred: boolean;
}

export interface StripeChange {
  read: "out" | "in" | null;
  star: "on" | "off" | null;
}

/** What the row stripe should play; a row that just mounted plays nothing. */
export function stripeChange(prev: StripeState | null, next: StripeState): StripeChange {
  if (!prev) return { read: null, star: null };
  return {
    read: prev.unread === next.unread ? null : next.unread ? "in" : "out",
    star: prev.starred === next.starred ? null : next.starred ? "on" : "off",
  };
}
