import { useCallback, useEffect, useMemo, useRef } from "react";

export interface DebouncedCallback<Args extends unknown[]> {
  (...args: Args): void;
  /** Runs the pending call now (if any) and clears the timer. */
  flush: () => void;
  /** Drops the pending call without running it. */
  cancel: () => void;
}

/** Delays `fn` by `ms` after the last call; `fn` is read through a ref so the
 *  returned function stays stable, and a pending call is flushed on unmount. */
export function useDebouncedCallback<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): DebouncedCallback<Args> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<Args | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingArgsRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingArgsRef.current;
    pendingArgsRef.current = null;
    if (pending) fnRef.current(...pending);
  }, []);

  const call = useCallback((...args: Args) => {
    pendingArgsRef.current = args;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, ms);
  }, [ms, flush]);

  useEffect(() => () => flush(), [flush]);

  return useMemo(() => {
    const debounced = call as DebouncedCallback<Args>;
    debounced.flush = flush;
    debounced.cancel = cancel;
    return debounced;
  }, [call, flush, cancel]);
}
