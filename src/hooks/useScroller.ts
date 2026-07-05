import { useEffect, useRef, type RefObject } from "react";
import { useOverlayScrollbars } from "overlayscrollbars-react";

/**
 * Attaches OverlayScrollbars to an existing element (the element itself stays
 * the scroll viewport), so refs, onScroll handlers, virtualizers and sticky
 * children keep working untouched while the themed (`os-theme-prudii`) scrollbar
 * is overlaid. Use for structurally sensitive containers; use the <Scroller>
 * component for plain wrap-able content.
 *
 * Pass an existing ref (e.g. a virtualizer's scroll ref) or let it create one.
 */
export function useScroller<T extends HTMLElement = HTMLDivElement>(
  externalRef?: RefObject<T | null>,
): RefObject<T | null> {
  const internalRef = useRef<T>(null);
  const ref = externalRef ?? internalRef;

  const [initialize] = useOverlayScrollbars({
    options: {
      scrollbars: {
        theme: "os-theme-prudii",
        autoHide: "leave",
        autoHideDelay: 500,
        clickScroll: true,
      },
    },
    defer: true,
  });

  useEffect(() => {
    const el = ref.current;
    if (el) initialize({ target: el, elements: { viewport: el } });
  }, [initialize, ref]);

  return ref;
}
