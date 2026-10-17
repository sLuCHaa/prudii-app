import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

describe("design tokens", () => {
  it("sets the soft radius scale", () => {
    for (const decl of ["--radius-sm: 0.5rem", "--radius-md: 0.625rem", "--radius-lg: 1rem", "--radius-xl: 1.25rem", "--radius-control: 0.75rem"]) expect(css).toContain(decl);
  });
  it("anchors the filled gradient on the original fill", () => {
    expect(css).toMatch(/\.tactile-filled\s*\{[^}]*var\(--tactile-fill\) 50%/);
  });
  it("defines the new tokens in every theme scope", () => {
    const decls = (t: string) => (css.match(new RegExp(`^\\s*${t}\\s*(?:#|rgba?\\()`, "gm")) ?? []).length;
    for (const t of ["--c-tile:", "--c-edge-light:", "--c-field-inset:", "--c-card-drop:", "--c-tile-drop:"]) expect(decls(t)).toBe(decls("--c-surface:"));
  });
  it("applies list density to the row body, not the tile gutter", () => {
    expect(css).toMatch(/\[data-density="compact"\] \.mail-row-body\s*\{/);
    expect(css).toMatch(/\[data-density="spacious"\] \.mail-row-body\s*\{/);
    expect(css).not.toMatch(/\[data-density[^{]*\.mail-item-draggable/);
  });
  it("drops the accent bar from the active folder", () => {
    expect(css).not.toContain(".folder-active::before");
  });
  it("insets the tile ring and shares it with the active folder", () => {
    expect(css).toMatch(/\.tile-raised,\s*\.folder-active\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--c-border\), 0 2px 6px -2px var\(--c-tile-drop\)/);
    expect(css.match(/0 2px 6px -2px var\(--c-tile-drop\)/g)).toHaveLength(2);
  });
  it("deepens the tile shadow in the light theme only", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--c-tile-drop:\s*rgba\(40, 25, 10, 0\.22\)/);
    expect(css).toMatch(/\.dark\s*\{[^}]*--c-tile-drop:\s*rgba\(0, 0, 0, 0\.45\)/);
  });
  it("lets quiet buttons answer hover and press on dark surfaces", () => {
    expect(css).toMatch(/\.tactile-quiet:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*color-mix\(in srgb, var\(--c-border\) 75%, var\(--c-text\)\)/);
    expect(css).toMatch(/\.tactile-quiet:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--c-hover\)/);
    expect(css).toMatch(/\.tactile-quiet:active:not\(:disabled\)\s*\{[^}]*background:\s*var\(--c-active\)/);
    expect(css).not.toMatch(/\.tactile-quiet:active:not\(:disabled\)\s*\{[^}]*filter/);
  });
  it("only grows along the radius scale", () => {
    const rem = (name: string) => Number(css.match(new RegExp(`--radius-${name}:\\s*([\\d.]+)rem`))?.[1]);
    const scale = ["sm", "md", "control", "lg", "xl", "2xl"].map(rem);
    expect(scale.filter(Number.isNaN)).toEqual([]);
    expect(scale.slice(1).every((v, i) => v > scale[i])).toBe(true);
  });
  it("anchors the switch's on-state on the accent", () => {
    expect(css).toMatch(/\.switch-track\[aria-checked="true"\]\s*\{[^}]*var\(--c-accent\) 50%/);
  });
  it("raises the chosen segment and option tile as tiles", () => {
    expect(css).toMatch(/\.segmented-item\[aria-pressed="true"\][^{]*\{[^}]*var\(--c-tile\)/);
    expect(css).toMatch(/\.segmented-item[^{]*\[aria-selected="true"\][^{]*\{[^}]*var\(--c-tile\)/);
    expect(css).toMatch(/\.option-tile\[aria-pressed="true"\]\s*\{[^}]*var\(--c-tile\)/);
  });
  it("keeps reduced motion still", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.tactile-filled[\s\S]*?transform: none/);
  });
});
