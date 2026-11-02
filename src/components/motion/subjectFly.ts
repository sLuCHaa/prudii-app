// A clicked list row hands its subject's position to the reading pane, whose title then flies in from there.
// The flight is a fixed copy above everything: the reading pane clips what lies outside it.
import { prefersReducedMotion } from "./tokens";

const FLY_MS = 280;
const STALE_MS = 400;

interface PendingFly {
  mailId: string;
  rect: DOMRect;
  fontSize: number;
  at: number;
}

let pending: PendingFly | null = null;

export function launchSubjectFly(mailId: string, source: Element | null): void {
  pending = null;
  if (!source || prefersReducedMotion()) return;
  pending = { mailId, rect: source.getBoundingClientRect(), fontSize: parseFloat(getComputedStyle(source).fontSize) || 14, at: performance.now() };
}

export function subjectFlyPending(mailId: string | undefined): boolean {
  return !!pending && pending.mailId === mailId && performance.now() - pending.at < STALE_MS;
}

export function landSubjectFly(mailId: string, title: HTMLElement): void {
  const fly = pending;
  if (!fly || fly.mailId !== mailId) return;
  pending = null;
  if (performance.now() - fly.at > STALE_MS) return;

  const to = title.getBoundingClientRect();
  const scale = fly.fontSize / (parseFloat(getComputedStyle(title).fontSize) || fly.fontSize);
  const ghost = title.cloneNode(true) as HTMLElement;
  if (typeof ghost.animate !== "function") return;
  ghost.removeAttribute("title");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${to.left}px`,
    top: `${to.top}px`,
    width: `${to.width}px`,
    margin: "0",
    zIndex: "60",
    pointerEvents: "none",
    transformOrigin: "0 0",
  });
  document.body.appendChild(ghost);
  title.style.visibility = "hidden";
  const land = () => {
    ghost.remove();
    title.style.visibility = "";
  };
  ghost
    .animate(
      [
        { transform: `translate(${fly.rect.left - to.left}px, ${fly.rect.top - to.top}px) scale(${scale})`, opacity: 0.7 },
        { transform: "none", opacity: 1 },
      ],
      { duration: FLY_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    )
    .finished.then(land, land);
}
