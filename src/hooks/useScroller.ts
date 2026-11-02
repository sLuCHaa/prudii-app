import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useOverlayScrollbars } from "overlayscrollbars-react";

/**
 * Attaches OverlayScrollbars to an existing scroll element, so refs, onScroll
 * handlers, virtualizers and sticky children keep working untouched while the
 * themed (`os-theme-prudii`) scrollbar is overlaid. Use for structurally
 * sensitive containers; use the <Scroller> component for plain wrap-able content.
 *
 * Render the scroll element (`viewport`) as the only child of `host`, which
 * holds the scrollbars: inside the scroll element they would scroll along and
 * be pulled back by script a frame late, so they jitter. The library resets the
 * scroll element's padding — pad an inner element instead.
 *
 * Pass an existing ref (e.g. a virtualizer's scroll ref) or let it create one.
 * `immediate` for containers that will hold iframes: setting up moves the scroll
 * element, and a moved iframe reloads. `virtualized` for windowed lists: rows
 * mount and unmount every scrolled frame, and re-measuring on each of those
 * forced a layout per frame. Only the size container's own style matters there.
 */
export function useScroller<T extends HTMLElement = HTMLDivElement>(
  externalRef?: RefObject<T | null>,
  { immediate = false, virtualized = false }: { immediate?: boolean; virtualized?: boolean } = {},
): { host: RefObject<HTMLDivElement | null>; viewport: RefObject<T | null> } {
  const host = useRef<HTMLDivElement>(null);
  const internalRef = useRef<T>(null);
  const viewport = externalRef ?? internalRef;

  // Stable identity: the library re-applies changed options on every render, and a scrolling list renders every frame.
  const options = useMemo(
    () => ({
      scrollbars: {
        theme: "os-theme-prudii",
        autoHide: "leave" as const,
        autoHideDelay: 500,
        clickScroll: true,
      },
      update: virtualized
        ? { ignoreMutation: (m: MutationRecord) => !(m.type === "attributes" && (m.target as Element).parentElement === viewport.current) }
        : {},
    }),
    [virtualized, viewport],
  );
  const [initialize] = useOverlayScrollbars({ options, defer: !immediate });

  useEffect(() => {
    if (host.current && viewport.current) {
      // A generated padding element would re-parent the React-owned scroll element.
      initialize({ target: host.current, elements: { viewport: viewport.current, padding: false, content: false } });
    }
  }, [initialize, viewport]);

  return { host, viewport };
}
