import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardButton, TabButton } from "../components/ui/TabButton";
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

  it("lifts the open mail's row above its neighbours", () => {
    expect(sourceOf("layout/MailList.tsx")).toMatch(/zIndex: selectedMailId === mail\.id \? 1 : undefined/);
  });

  it("keeps the unread stripe inside the rounded row", () => {
    const stripes = classStrings().filter(({ file, cls }) => file === "layout/MailList.tsx" && cls.includes("w-[3px]"));
    expect(stripes).toHaveLength(2);
    expect(stripes.filter(({ cls }) => !/\bleft-0\.5\b/.test(cls) || !/\btop-2\.5\b/.test(cls) || !/\bbottom-2\.5\b/.test(cls))).toEqual([]);
  });

  it("selects folders as tiles without an accent bar", () => {
    expect(sourceOf("ui/TabButton.tsx")).not.toContain("borderLeft");
  });

  it("keeps the accent on the selected folder icon, not on its trailing marks", () => {
    const selected = renderToStaticMarkup(createElement(CardButton, { selected: true, leading: createElement("svg"), trailing: createElement("i"), children: "Inbox" }));
    expect(selected).toMatch(/<span class="[^"]*\btext-accent\b[^"]*"><svg>/);
    expect(selected).toMatch(/<span class="shrink-0"><i>/);
    expect(renderToStaticMarkup(createElement(CardButton, { selected: false, leading: createElement("svg"), children: "Inbox" }))).not.toContain("text-accent");
  });

  it("leaves room for the tile shadow inside collapsing folder lists", () => {
    const wrappers = sourceOf("layout/Sidebar.tsx").match(/<Collapse[^>]*>\s*<div className="[^"]*"/g) ?? [];
    expect(wrappers).toHaveLength(3);
    expect(wrappers.filter((w) => !/\bpx-px\b/.test(w) || !/\bpb-1\b/.test(w))).toEqual([]);
  });

  it("uses composable shadows on the reading card", () => {
    const card = classStrings().find(({ file, cls }) => file.endsWith("ThreadView.tsx") && cls.includes("bg-surface border border-border rounded-xl"));
    expect(card?.cls).toContain("shadow-card-soft");
    expect(card?.cls).toContain("inset-shadow-edge");
  });

  it("lights the top edge of raised panels", () => {
    const files = [
      "ui/DialogProvider.tsx", "ui/ContextMenu.tsx", "ui/CommandPalette.tsx", "settings/SettingsPanel.tsx", "ui/DateField.tsx", "ui/UndoToast.tsx",
      "motion/StackedToast.tsx", "layout/MailSortMenu.tsx", "ui/PrivacyBadge.tsx", "layout/Sidebar.tsx", "compose/ComposeModal.tsx",
      "editor/LinkDialog.tsx", "calendar/SubscribeDialog.tsx", "calendar/EventPopover.tsx", "ui/ShortcutHelp.tsx", "ui/WhatsNew.tsx", "tasks/TaskDrawer.tsx",
      "calendar/DayListPopover.tsx", "calendar/EventDrawer.tsx", "calendar/RecurrenceScopeDialog.tsx", "compose/ComposePreview.tsx", "compose/RecipientInput.tsx",
      "layout/AttachmentBrowser.tsx", "layout/TrackingIndicator.tsx", "tasks/MailAttachmentPickDialog.tsx", "tasks/QuickAdd.tsx", "tasks/TaskPickerDialog.tsx",
      "ui/ErrorBoundary.tsx", "ui/FlagPicker.tsx", "accounts/AccountWizard.tsx",
    ];
    expect(files.filter((f) => !sourceOf(f).includes("inset-shadow-edge"))).toEqual([]);
    expect(sourceOf("settings/SettingsPanel.tsx")).not.toContain("boxShadow");
    expect(sourceOf("accounts/AccountWizard.tsx")).not.toContain("boxShadow");
  });

  it("lights the header where a tinted header covers the panel's top", () => {
    const headers = classStrings().filter(({ file, cls }) => ["compose/ComposeModal.tsx", "editor/LinkDialog.tsx", "compose/ComposePreview.tsx", "layout/TrackingIndicator.tsx"].includes(file) && cls.includes("border-b border-border bg-bg-secondary"));
    expect(headers).toHaveLength(5);
    expect(headers.filter(({ cls }) => !cls.includes("inset-shadow-edge")).map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it("keeps the dark shadow on the settings panel", () => {
    const src = sourceOf("settings/SettingsPanel.tsx");
    expect(src).toContain("shadow-[var(--shadow-lg)]");
    expect(src).not.toMatch(/(?<![-\w])shadow-lg\b/);
  });

  it("keeps small icon buttons on control corners", () => {
    const small = classStrings().filter(({ cls }) => /\brounded-lg\b/.test(cls) && (/(?<![-\w])p-1\.5\b/.test(cls) || /\bh-7 w-7\b/.test(cls)));
    expect(small.map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it("matches the save-draft dialog buttons", () => {
    expect(sourceOf("compose/ComposeModal.tsx")).not.toMatch(/w-full px-4 py-2\.5 rounded-lg/);
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
    expect(src).not.toContain("motion-reduce:transform-none");
    const wrap = classStrings().find(({ file, cls }) => file === "compose/ComposeModal.tsx" && cls.includes("[box-shadow:0_2px_8px_rgba(59,130,246,0.25)]"));
    expect(wrap?.cls).toContain("transition-[translate]");
    expect(wrap?.cls).toContain("motion-safe:hover:-translate-y-px motion-safe:active:translate-y-px");
    expect(wrap?.cls).toContain("showScheduleMenu");
    expect(wrap?.cls).not.toMatch(/(?<!motion-safe:)(?:hover|active):-?translate-y-px/);
    expect(classStrings().some(({ file, cls }) => file.endsWith("ComposeModal.tsx") && cls.includes("pointer-events-none") && cls.includes("rounded-[inherit]") && cls.includes("inset-shadow-[0_1px_0_rgba(255,255,255,.32)]"))).toBe(true);
  });

  it("gives chips and notice badges 8px corners", () => {
    const files = ["tasks/MailTaskChip.tsx", "layout/TrackingIndicator.tsx", "ui/PremiumBadge.tsx"];
    expect(files.filter((f) => !/\brounded-sm\b/.test(sourceOf(f)))).toEqual([]);
    const badges = classStrings().filter(({ file, cls }) => ["layout/ThreadView.tsx", "calendar/InvitationCard.tsx", "calendar/AgendaList.tsx"].includes(file) && /\bpx-1\.5\b/.test(cls) && /\bpy-0\.5\b/.test(cls) && /\brounded\b/.test(cls));
    expect(badges).toHaveLength(5);
    expect(badges.filter(({ cls }) => !/\brounded-sm\b/.test(cls)).map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it("drops the old accent-frame selection from the settings", () => {
    const files = Object.keys(sources).filter((f) => f.startsWith("settings/"));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => /border-accent bg-accent-soft|bg-accent-soft text-accent/.test(sourceOf(f)))).toEqual([]);
  });

  it("lays the settings tabs into a track", () => {
    const src = sourceOf("settings/SettingsPanel.tsx");
    expect(src).toMatch(/role="tablist"[^>]*segmented-track|segmented-track[^>]*role="tablist"/);
    expect(sourceOf("ui/TabButton.tsx")).toContain("segmented-item");
    const tab = renderToStaticMarkup(createElement(TabButton, { selected: true, children: "General" }));
    expect(tab).toContain('role="tab"');
    expect(tab).toContain('aria-selected="true"');
    expect(renderToStaticMarkup(createElement(TabButton, { selected: false, children: "x" }))).toContain('aria-selected="false"');
  });

  it("lights the edge of the settings option rows", () => {
    const rows = classStrings().filter(({ file, cls }) => file.startsWith("settings/") && /\bp-3\b/.test(cls) && /\bborder-border\b/.test(cls) && /\bhover:bg-hover\b/.test(cls));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter(({ cls }) => !/\binset-shadow-edge\b/.test(cls)).map((r) => r.line)).toEqual([]);
  });

  it("groups the general tab into section cards", () => {
    const src = sourceOf("settings/SettingsPanel.tsx");
    expect(src).toContain("settings-canvas");
    expect(src).toContain("<SettingsGroup");
    expect(src).not.toMatch(/\[&>\*\+\*\]:border-t/);
    expect((src.match(/<SettingsGroup/g) ?? []).length).toBeGreaterThanOrEqual(12);
    expect(src).toMatch(/function InfoPanel[\s\S]*?<SettingsGroup/);
    expect(src).not.toContain('className="text-center py-12"');
  });

  it("keeps the privacy trigger square like its title-bar neighbours", () => {
    const trigger = classStrings().find(({ file, cls }) => file === "ui/PrivacyBadge.tsx" && cls.includes("w-11 h-full"));
    expect(trigger).toBeDefined();
    expect(trigger?.cls).not.toMatch(/\brounded/);
  });

  it("switches on/off options instead of ticking them", () => {
    const toggles = ["settings/SettingsPanel.tsx", "settings/PrivacySettings.tsx", "settings/AiSettings.tsx", "calendar/EventDrawer.tsx", "calendar/CalendarView.tsx"];
    expect(toggles.filter((f) => sourceOf(f).includes('type="checkbox"'))).toEqual([]);
    for (const f of ["settings/RulesPanel.tsx", "settings/BackupOptionsForm.tsx", "tasks/MailAttachmentPickDialog.tsx"]) expect(sourceOf(f)).toContain('type="checkbox"');
  });
});
