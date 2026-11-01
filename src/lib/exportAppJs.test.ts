import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const appJs = readFileSync(resolve(__dirname, "../../src-tauri/src/export/assets/app.js"), "utf8");

const labels = {
  lang: "en",
  title: "Prudii Export",
  searchPlaceholder: "Search",
  noSubject: "(no subject)",
  accountsOne: "{count} account",
  accountsOther: "{count} accounts",
  mailsOne: "{count} mail",
  mailsOther: "{count} mails",
  emptyFolder: "This folder is empty.",
  noResults: "Nothing found.",
  localCopyTitle: "From local copy",
  failedTitle: "Could not be exported",
};

const indexMarkup = `<header class="bar"><div class="logo">Prudii <span>Export</span></div><div class="meta" id="meta"></div><input class="search" id="search" type="search"></header>
<div class="layout" id="app"><nav class="side" id="side"></nav><main class="list" id="list"><div id="hints"></div><div id="rows"></div></main></div>
<script type="application/json" id="prudii-labels">${JSON.stringify(labels)}</script>`;

function entries(count: number, prefix = "") {
  return Array.from({ length: count }, (_, i) => {
    const jonas = i % 2 === 1;
    return {
      s: `${prefix}Betreff ${i}`,
      f: jonas ? "Jonas Brandt" : "Anna Weber",
      e: jonas ? "jonas.brandt@studio-halde.example" : "anna@studio-halde.example",
      d: new Date(Date.UTC(2026, 9, 28, 12, 0) - i * 3_600_000).toISOString(),
      p: "Vorschau",
      a: i % 3 === 0,
      h: `konto/Posteingang/mail-${i}.html`,
    };
  });
}

function load(data: unknown) {
  document.body.innerHTML = indexMarkup;
  (window as unknown as { PRUDII_EXPORT: unknown }).PRUDII_EXPORT = data;
  document.dispatchEvent(new Event("DOMContentLoaded"));
}

const rows = () => document.querySelectorAll("#rows .row");

describe("export app.js index", () => {
  beforeAll(() => {
    window.eval(appJs);
  });

  beforeEach(() => {
    window.location.hash = "";
  });

  const base = (mails: ReturnType<typeof entries>) => ({
    createdAt: "2026-11-01T16:40:00+01:00",
    cancelled: false,
    accounts: [
      {
        name: "Anna",
        email: "anna@studio-halde.example",
        folders: [{ id: "f1", name: "Posteingang", folderType: "inbox", mails }],
      },
    ],
    localCopy: [],
    failed: [],
  });

  it("renders 200 rows first and loads more near the end", () => {
    load(base(entries(1000)));
    expect(rows().length).toBe(200);
    window.dispatchEvent(new Event("scroll"));
    expect(rows().length).toBe(400);
  });

  it("searches sender names across all rows", () => {
    load(base(entries(1000)));
    const search = document.getElementById("search") as HTMLInputElement;
    search.value = "jonas";
    search.dispatchEvent(new Event("input"));
    const shown = rows();
    expect(shown.length).toBe(200);
    shown.forEach((row) => expect(row.textContent).toContain("Jonas Brandt"));
    expect(document.getElementById("rows")!.textContent).toContain("500");
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("scroll"));
    expect(rows().length).toBe(500);
  });

  it("matches subject and email case-insensitively and reports empty results", () => {
    load(base(entries(10)));
    const search = document.getElementById("search") as HTMLInputElement;
    search.value = "BETREFF 7";
    search.dispatchEvent(new Event("input"));
    expect(rows().length).toBe(1);
    search.value = "STUDIO-HALDE.EXAMPLE";
    search.dispatchEvent(new Event("input"));
    expect(rows().length).toBe(10);
    search.value = "gibt-es-nicht";
    search.dispatchEvent(new Event("input"));
    expect(rows().length).toBe(0);
    expect(document.getElementById("rows")!.textContent).toContain("Nothing found.");
  });

  it("selects the folder from the hash and groups mails by month", () => {
    const data = base(entries(3));
    data.accounts[0].folders.push({ id: "f2", name: "Archiv", folderType: "archive", mails: entries(2, "Alt ").map((m) => ({ ...m, d: "2026-09-02T10:00:00Z" })) });
    window.location.hash = "#f2";
    load(data);
    expect(rows().length).toBe(2);
    expect(document.querySelectorAll("#rows .month").length).toBe(1);
    expect(document.querySelector("#side .f.on")!.textContent).toContain("Archiv");
  });

  it("shows hint blocks only when lists are not empty and keeps failed mails unlinked", () => {
    const data = base(entries(2));
    load(data);
    expect(document.querySelectorAll("#hints details").length).toBe(0);
    const withHints = {
      ...data,
      failed: [{ s: "Kaputt", f: "Anna Weber", e: "anna@studio-halde.example", d: "2026-10-01T10:00:00Z", p: "", a: false, h: null }],
    };
    load(withHints);
    const block = document.querySelector("#hints details") as HTMLDetailsElement;
    expect(block).not.toBeNull();
    block.open = true;
    block.dispatchEvent(new Event("toggle"));
    expect(block.querySelectorAll("a.row").length).toBe(0);
    expect(block.querySelectorAll(".row").length).toBe(1);
  });

  it("uses text content only, never markup from mail data", () => {
    const evil = entries(1);
    evil[0].s = "<img src=x onerror=alert(1)>";
    load(base(evil));
    expect(document.querySelector("#rows img")).toBeNull();
    expect(document.querySelector("#rows .subj")!.textContent).toContain("<img src=x");
  });
});

describe("export app.js mail page", () => {
  it("formats dates and sizes", () => {
    document.documentElement.lang = "en";
    document.body.innerHTML = `<div class="mail"><time datetime="2026-10-21T13:28:44Z">2026-10-21 13:28</time><span data-bytes="2516582">2.4 MB</span></div>`;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(document.querySelector("time")!.textContent).toMatch(/2026/);
    expect(document.querySelector("time")!.textContent).not.toBe("2026-10-21 13:28");
    expect(document.querySelector("[data-bytes]")!.textContent).toBe("2.4 MB");
  });
});
