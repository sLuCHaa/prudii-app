import { describe, expect, it } from "vitest";
import { SECTION_ACTION } from "../components/tasks/TaskSectionHead";

const raw = import.meta.glob("../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const files = Object.entries(raw).map(([path, text]) => ({ file: path.replace("../components/", ""), text }));

describe("loading indicators", () => {
  it("uses no spinner icon", () => {
    expect(files.filter((f) => /\bLoader2\b/.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it("uses no spin or pulse utility", () => {
    expect(files.filter((f) => f.text.includes("animate-spin")).map((f) => f.file)).toEqual([]);
    expect(files.filter((f) => f.text.includes("animate-pulse")).map((f) => f.file)).toEqual(["ai/AiSummary.tsx"]);
  });
});

describe("busy controls", () => {
  it("keeps the task files button at full strength while busy", () => {
    expect(SECTION_ACTION).not.toContain("disabled:opacity-50");
  });

  it("sizes a mini thread like the 14 px icon it swaps with", () => {
    for (const file of ["layout/OfflineBanner.tsx", "settings/BackupRestore.tsx", "backup/BackupExportWindow.tsx"]) {
      const minis = files.find((f) => f.file === file)!.text.match(/<LightThread form="mini"[^>]*>/g) ?? [];
      expect(minis.length).toBeGreaterThan(0);
      expect(minis.filter((m) => !m.includes("width={14}"))).toEqual([]);
    }
  });
});
