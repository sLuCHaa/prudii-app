(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import { getDayPhase } from "../motion/DaylightSky";
import { NoTasksState } from "./NoTasksState";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render() {
  act(() => root.render(createElement(NoTasksState)));
}

/** The pool the component should be drawing from at the current hour. */
function poolForNow(): string[] {
  const lines = i18n.t(`atmosphere.noTasks.${getDayPhase(new Date())}`, { returnObjects: true });
  return Array.isArray(lines) ? lines.map(String) : [];
}

describe("NoTasksState", () => {
  it("shows the headline", () => {
    render();
    expect(document.body.textContent).toContain(i18n.t("tasks.empty"));
  });

  it("draws one line from the pool for the current time of day", () => {
    render();
    const pool = poolForNow();
    expect(pool.length, "no atmosphere pool for this hour").toBeGreaterThan(0);
    const shown = pool.filter((line) => document.body.textContent?.includes(line));
    expect(shown.length, `none of ${JSON.stringify(pool)} was rendered`).toBe(1);
  });

  it("covers every hour of the day with a pool", () => {
    // A missing phase would silently fall back to the static line for a third of
    // the day, which is exactly the kind of gap nobody notices.
    for (const phase of ["dawn", "day", "dusk", "night"]) {
      const lines = i18n.t(`atmosphere.noTasks.${phase}`, { returnObjects: true });
      expect(Array.isArray(lines) && lines.length > 0, `no lines for ${phase}`).toBe(true);
    }
  });

  it("renders the ruled lines of the pad", () => {
    render();
    expect(document.querySelectorAll("svg line").length).toBe(3);
  });
});
