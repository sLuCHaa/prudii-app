// A mail dropped on a folder flies from the cursor into it. The folder notes itself on drop;
// the list's drag end, which fires right after, launches the flight from its drag preview.
import { prefersReducedMotion } from "./tokens";

export const DROP_FLIGHT_MS = 320;

let target: { rect: DOMRect; at: number } | null = null;

export function noteDropTarget(el: Element | null | undefined): void {
  target = el ? { rect: el.getBoundingClientRect(), at: performance.now() } : null;
}

export function flyIntoDropTarget(preview: HTMLElement | null): void {
  const goal = target;
  target = null;
  if (!goal || !preview || performance.now() - goal.at > 500 || prefersReducedMotion()) return;
  const from = preview.getBoundingClientRect();
  const ghost = preview.cloneNode(true) as HTMLElement;
  if (typeof ghost.animate !== "function") return;
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, transform: "none", transformOrigin: "50% 50%" });
  document.body.appendChild(ghost);
  const dx = goal.rect.left + goal.rect.width / 2 - (from.left + from.width / 2);
  const dy = goal.rect.top + goal.rect.height / 2 - (from.top + from.height / 2);
  const done = () => ghost.remove();
  ghost
    .animate(
      [
        { transform: "translate(0, 0) scale(1) rotate(1deg)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.12) rotate(0deg)`, opacity: 0.15 },
      ],
      { duration: DROP_FLIGHT_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    )
    .finished.then(done, done);
}
