import { useEffect, type RefObject } from "react";

const USER_INPUT = ["wheel", "mousedown", "keydown", "touchstart"] as const;

// Stops at the first user input and re-arms only on the next opened mail, so it never fights the reader.
export function useChatAnchor(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  openedMailId: string,
  enabled: boolean,
) {
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !scroller || !content) return;

    let active = true;
    const pin = () => {
      if (!active) return;
      const messages = content.querySelectorAll("[data-mail-id]");
      const newest = messages[messages.length - 1];
      if (!newest) return;
      scroller.scrollTop += newest.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    };
    const release = () => { active = false; };

    USER_INPUT.forEach((type) => window.addEventListener(type, release, { capture: true, passive: true }));
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    pin();

    return () => {
      release();
      observer.disconnect();
      USER_INPUT.forEach((type) => window.removeEventListener(type, release, { capture: true }));
    };
  }, [scrollRef, contentRef, openedMailId, enabled]);
}
