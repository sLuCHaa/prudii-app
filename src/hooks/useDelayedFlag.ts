import { useEffect, useState } from "react";

/** True once `flag` has held for `delayMs`; drops with it at once. Keeps quick work from flashing an indicator. */
export function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);
  return flag && shown;
}
