import { useState } from "react";
import { stripeChange, type StripeChange, type StripeState } from "../../lib/stripeMotion";

/**
 * The stripe at a mail row's left edge: blue while unread, gold while starred.
 * Only a change of a mounted row animates; rows scrolled into view show their
 * state at once. Out and in alternate, so each change restarts its keyframes.
 */
export function MailStripe({ unread, starred }: StripeState) {
  const [prev, setPrev] = useState<StripeState>({ unread, starred });
  const [anim, setAnim] = useState<StripeChange>({ read: null, star: null });

  if (prev.unread !== unread || prev.starred !== starred) {
    const change = stripeChange(prev, { unread, starred });
    setPrev({ unread, starred });
    setAnim((a) => ({ read: change.read ?? a.read, star: change.star ?? a.star }));
  }

  return (
    <div aria-hidden className="mail-stripe absolute left-0.5 top-2.5 bottom-2.5 w-[3px]">
      <span className="mail-stripe-read" data-unread={unread} data-anim={anim.read ?? undefined} />
      <span className="mail-stripe-star" data-on={starred} data-anim={anim.star ?? undefined} />
    </div>
  );
}
