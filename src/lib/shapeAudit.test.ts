import { describe, expect, it } from "vitest";
import { extractClassStrings } from "./classAudit";

const raw = import.meta.glob("../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sources: Record<string, string> = {};
for (const [path, text] of Object.entries(raw)) {
  sources[path.replace("../components/", "")] = text;
}

export function sourceOf(rel: string): string {
  const text = sources[rel];
  if (text === undefined) throw new Error(`unknown source: ${rel}`);
  return text;
}

export function classStrings(): { file: string; line: number; cls: string }[] {
  return Object.entries(sources).flatMap(([file, text]) => extractClassStrings(file, text));
}

describe("class string extraction", () => {
  it("keeps a split className ternary as one entry", () => {
    const src = 'const a = <div className={x ? "rounded-lg bg-accent" : "text-white"} />;';
    const hit = extractClassStrings("f.tsx", src).find((c) => c.cls.includes("bg-accent"));
    expect(hit?.cls).toContain("rounded-lg");
    expect(hit?.cls).toContain("text-white");
  });

  it("does not let an apostrophe in JSX text swallow a className", () => {
    const src = ["<p>don't</p>", `<b className="bg-accent text-white rounded-lg">it's</b>`].join("\n");
    const hit = extractClassStrings("f.tsx", src).find((c) => c.cls.includes("bg-accent"));
    expect(hit?.line).toBe(2);
  });

  it("reads nested templates and multi-line className expressions", () => {
    const src = ["<i", " className={`a ${x ? `rounded-xl` : ''} bg-accent", " text-white`}", "/>"].join("\n");
    const hit = extractClassStrings("f.tsx", src).find((c) => c.cls.includes("bg-accent"));
    expect(hit?.line).toBe(2);
    expect(hit?.cls).toContain("text-white");
    expect(hit?.cls).toContain("rounded-xl");
  });
});

describe("shape audit", () => {
  it("reads component sources", () => {
    expect(sourceOf("ui/Button.tsx").length).toBeGreaterThan(0);
    expect(() => sourceOf("nope/Nope.tsx")).toThrow();
  });

  it("leaves no flat hand-rolled filled button", () => {
    const flat = classStrings().filter(
      ({ cls }) =>
        /\bbg-accent\b/.test(cls) &&
        /\btext-white\b/.test(cls) &&
        /\brounded-(?:md|lg|xl|2xl)\b/.test(cls),
    );
    expect(flat.map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it("gives every text field soft corners and an inset", () => {
    const fields = classStrings().filter(({ cls }) => /\b(?:bg-bg-secondary|bg-surface)\b/.test(cls) && /\bfocus:border-accent\b/.test(cls));
    expect(fields.length).toBeGreaterThan(8);
    expect(fields.filter(({ cls }) => !/\brounded-control\b/.test(cls) || !/\binset-shadow-field\b/.test(cls)).map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it("shows the open mail as a raised tile", () => {
    const src = sourceOf("layout/MailList.tsx");
    expect(src).toContain("tile-raised");
    expect(src).not.toMatch(/mail-item-draggable[^"`]*border-b/);
    expect(src).not.toMatch(/text-left select-none px-4 py-2\.5 border-b/);
  });

  it("carries the density class on the mail row body", () => {
    expect(sourceOf("layout/MailList.tsx")).toMatch(/mail-row-body relative px-4 py-2\.5/);
  });

  it("selects folders as tiles without an accent bar", () => {
    expect(sourceOf("ui/TabButton.tsx")).not.toContain("borderLeft");
  });

  it("uses composable shadows on the reading card", () => {
    const card = classStrings().find(({ file, cls }) => file.endsWith("ThreadView.tsx") && cls.includes("bg-surface border border-border rounded-xl"));
    expect(card?.cls).toContain("shadow-card-soft");
    expect(card?.cls).toContain("inset-shadow-edge");
  });

  it("lights the top edge of raised panels", () => {
    const files = ["ui/DialogProvider.tsx", "ui/ContextMenu.tsx", "ui/CommandPalette.tsx", "settings/SettingsPanel.tsx", "ui/DateField.tsx", "ui/UndoToast.tsx", "motion/StackedToast.tsx", "layout/MailSortMenu.tsx", "ui/PrivacyBadge.tsx", "layout/Sidebar.tsx", "compose/ComposeModal.tsx"];
    expect(files.filter((f) => !sourceOf(f).includes("inset-shadow-edge"))).toEqual([]);
    expect(sourceOf("settings/SettingsPanel.tsx")).not.toContain("boxShadow");
  });

  it("gives the compose button soft corners in both states", () => {
    const buttons = classStrings().filter(({ file, cls }) => file.endsWith("ComposeButton.tsx") && cls.includes("items-center justify-center"));
    expect(buttons).toHaveLength(2);
    expect(buttons.filter(({ cls }) => /\brounded-(?:full|xl)\b/.test(cls) || !/\brounded-control\b/.test(cls))).toEqual([]);
  });

  it("shapes the send split button with control corners", () => {
    const src = sourceOf("compose/ComposeModal.tsx");
    expect(src).not.toMatch(/rounded-[lr]-xl\b/);
    expect(src).toContain("rounded-l-control");
    expect(src).toContain("rounded-r-control");
    expect(src).toContain("motion-reduce:transform-none");
    expect(classStrings().some(({ file, cls }) => file.endsWith("ComposeModal.tsx") && cls.includes("pointer-events-none") && cls.includes("rounded-[inherit]") && cls.includes("inset-shadow-[0_1px_0_rgba(255,255,255,.32)]"))).toBe(true);
  });

  it("gives chips and notice badges 8px corners", () => {
    const files = ["tasks/MailTaskChip.tsx", "layout/TrackingIndicator.tsx", "ui/PremiumBadge.tsx", "ui/PrivacyBadge.tsx"];
    expect(files.filter((f) => !/\brounded-sm\b/.test(sourceOf(f)))).toEqual([]);
  });
});
