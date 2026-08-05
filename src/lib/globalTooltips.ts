/**
 * Upgrades native `title` attributes to the app's styled tooltip bubble.
 * On first hover the title is moved to data-tip so the OS bubble never shows;
 * the styled bubble uses the same .tooltip-bubble CSS as the Tooltip component.
 */
export function installGlobalTooltips(): () => void {
  let bubble: HTMLDivElement | null = null;
  let timer: number | null = null;
  let current: HTMLElement | null = null;

  function hide() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    bubble?.remove();
    bubble = null;
    current = null;
  }

  function show(el: HTMLElement, text: string) {
    bubble?.remove();
    bubble = document.createElement("div");
    bubble.className = "tooltip-bubble";
    bubble.setAttribute("role", "tooltip");
    bubble.textContent = text;
    document.body.appendChild(bubble);

    const r = el.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const below = r.bottom + 6 + bh <= window.innerHeight - 8;
    const top = below ? r.bottom + 6 : r.top - 6 - bh;
    const left = Math.min(
      Math.max(8, r.left + r.width / 2 - bw / 2),
      window.innerWidth - bw - 8
    );
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }

  function onMouseOver(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const el = target?.closest?.("[title], [data-tip]") as HTMLElement | null;
    if (!el || el === current) return;

    const titleAttr = el.getAttribute("title");
    if (titleAttr) {
      el.setAttribute("data-tip", titleAttr);
      el.removeAttribute("title");
    }
    const text = el.getAttribute("data-tip");
    if (!text) return;

    hide();
    current = el;
    timer = window.setTimeout(() => show(el, text), 450);
  }

  function onMouseOut(e: MouseEvent) {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    hide();
  }

  document.addEventListener("mouseover", onMouseOver);
  document.addEventListener("mouseout", onMouseOut);
  document.addEventListener("mousedown", hide, true);
  window.addEventListener("blur", hide);

  return () => {
    hide();
    document.removeEventListener("mouseover", onMouseOver);
    document.removeEventListener("mouseout", onMouseOut);
    document.removeEventListener("mousedown", hide, true);
    window.removeEventListener("blur", hide);
  };
}
