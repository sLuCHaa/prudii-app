import { useState } from "react";
import { stripeChange, type StripeChange, type StripeState } from "../../lib/stripeMotion";

// Only a change of a mounted row animates; alternating out/in restarts the keyframes.
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
