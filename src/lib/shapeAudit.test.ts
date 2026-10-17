import { describe, expect, it } from "vitest";

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
  const out: { file: string; line: number; cls: string }[] = [];
  const re = /"([^"\n]*)"|`([^`]*)`|'([^'\n]*)'/g;
  for (const [file, text] of Object.entries(sources)) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const cls = m[1] ?? m[2] ?? m[3] ?? "";
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ file, line, cls });
    }
  }
  return out;
}

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
});
