import { useCallback, useRef } from "react";

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /** Double-click restores the panel's default width. */
  onReset?: () => void;
}

export function ResizeHandle({ onResize, onResizeStart, onResizeEnd, onReset }: ResizeHandleProps) {
  const startX = useRef(0);
  const pendingDelta = useRef(0);
  const rafId = useRef<number | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      onResizeStart?.();

      // Coalesce mousemove into one resize per frame — the raw event rate
      // re-rendered all three panes 60-120 times per second of dragging.
      const flush = () => {
        rafId.current = null;
        const delta = pendingDelta.current;
        pendingDelta.current = 0;
        if (delta !== 0) onResize(delta);
      };

      const handleMouseMove = (e: MouseEvent) => {
        pendingDelta.current += e.clientX - startX.current;
        startX.current = e.clientX;
        if (rafId.current === null) {
          rafId.current = requestAnimationFrame(flush);
        }
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        if (rafId.current !== null) {
          cancelAnimationFrame(rafId.current);
          flush();
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onResizeEnd?.();
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [onResize, onResizeStart, onResizeEnd]
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      className="relative w-1 shrink-0 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']"
    />
  );
}
