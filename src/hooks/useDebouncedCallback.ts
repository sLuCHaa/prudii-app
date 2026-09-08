import { useCallback, useEffect, useRef } from "react";

/** Delays `fn` by `ms` after the last call; a call within the window resets the timer.
 *  Reads `fn` through a ref so the returned function stays stable across re-renders. */
export function useDebouncedCallback<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): (...args: Args) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return useCallback((...args: Args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fnRef.current(...args), ms);
  }, [ms]);
}
