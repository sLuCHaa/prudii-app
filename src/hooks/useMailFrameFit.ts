import { useCallback, useEffect, useRef, useState } from "react";

// Marketing mail is built on fixed-width tables — Steam, invoices, newsletters
// all ship a 600-800px layout with hard `width` attributes on the cells. A
// `max-width: 100%` on the table cannot shrink that: the fixed cell widths set
// a minimum content width, so the table overflows and the frame's own document
// scrolls sideways.
//
// So we fit the content the way Apple Mail and Spark do: measure what the mail
// actually needs, scale it down to the pane and grow the body's layout box by
// the same factor, so it still lays out at its natural width before shrinking.
// The sender's layout survives intact — multi-column mail included — it just
// gets smaller. Forcing a reflow instead (width:auto !important) would collapse
// exactly those layouts, which is why no mail client does it.
const MIN_SCALE = 0.55;

/**
 * Factor to fit `natural` content width into `available` pane width.
 *
 * Never enlarges, and never shrinks past `minScale` — below that the text stops
 * being readable, so the frame keeps its sideways scroll instead.
 */
export function fitScale(available: number, natural: number, minScale = MIN_SCALE): number {
  if (available <= 0 || natural <= 0) return 1;
  return natural > available ? Math.max(minScale, available / natural) : 1;
}

/**
 * Keeps a mail iframe sized to its content and scaled to its pane.
 *
 * Returns the height to render the iframe at, plus `refit` for the caller to
 * fire on load and whenever the document changes.
 */
export function useMailFrameFit(iframeRef: React.RefObject<HTMLIFrameElement | null>) {
  const [height, setHeight] = useState(300);
  // The outer observer must react to width only. Re-fitting changes the
  // iframe's height, which would otherwise retrigger it forever.
  const lastWidth = useRef(0);

  const refit = useCallback(() => {
    try {
      const iframe = iframeRef.current;
      const doc = iframe?.contentDocument;
      const body = doc?.body;
      if (!iframe || !doc || !body) return;

      // Measure the natural layout, not the one the previous pass scaled.
      body.style.transform = "";
      body.style.transformOrigin = "";
      body.style.width = "";

      const available = iframe.clientWidth;
      if (available <= 0) return;
      lastWidth.current = available;

      const natural = Math.max(body.scrollWidth, doc.documentElement.scrollWidth);
      const scale = fitScale(available, natural);

      if (scale < 1) {
        body.style.transformOrigin = "0 0";
        body.style.transform = `scale(${scale})`;
        // Below MIN_SCALE the content stays wider than the pane and the frame
        // scrolls sideways after all — deliberately, since shrinking further
        // would leave the text unreadable.
        body.style.width = `${100 / scale}%`;
      }

      // Read after applying, so the reflow at the wider layout width counts.
      const h = Math.ceil(body.scrollHeight * scale);
      if (h > 0) setHeight(h);

      // Images that arrive late change the height; one re-fit each is enough.
      for (const img of Array.from(doc.images)) {
        if (!img.complete) img.addEventListener("load", refit, { once: true });
      }
    } catch {}
  }, [iframeRef]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (iframe.clientWidth !== lastWidth.current) refit();
    });
    observer.observe(iframe);
    return () => observer.disconnect();
  }, [iframeRef, refit]);

  return { height, refit };
}
