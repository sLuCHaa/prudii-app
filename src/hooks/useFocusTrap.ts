import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab within a modal container while `active`, and return focus to the
 * previously focused element on close. Extracted from DialogProvider so every
 * modal shares one implementation — before this, Tab walked out of most
 * modals into the mail list behind them.
 *
 * Attach the returned ref to the modal panel. Pass `initialFocus: false` when
 * the modal manages its own initial focus (e.g. an autofocused search input).
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  options: { initialFocus?: boolean } = {}
) {
  const { initialFocus = true } = options;
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previous = document.activeElement as HTMLElement | null;

    if (initialFocus) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      // Focus escaped the container (or sits on its edge): wrap it back in.
      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !container.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previous?.focus?.();
    };
  }, [active, initialFocus]);

  return ref;
}
