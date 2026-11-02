import { useEffect, useState } from "react";

/** True while `loading`, for at most `ms` per `key`: skips a half-loaded first frame without hiding a slow load. */
export function useLoadingHold(loading: boolean, key: string, ms: number): boolean {
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setExpiredFor(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return loading && expiredFor !== key;
}
