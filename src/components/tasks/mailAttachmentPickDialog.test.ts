(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import type { Attachment } from "../../types";
import { MailAttachmentPickDialog } from "./MailAttachmentPickDialog";

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

function att(id: string, filename: string, is_inline = false): Attachment {
  return {
    id,
    mail_id: "m1",
    filename,
    mime_type: null,
    size_bytes: 2048,
    content_id: null,
    is_inline,
    local_path: null,
  };
}

const ATTACHMENTS = [att("logo", "logo.png", true), att("invoice", "invoice.pdf"), att("notes", "notes.txt")];

let confirmed: string[][] = [];
let cancelled = 0;

function render(attachments: Attachment[] = ATTACHMENTS) {
  confirmed = [];
  cancelled = 0;
  act(() =>
    root.render(
      createElement(MailAttachmentPickDialog, {
        attachments,
        onConfirm: (ids: string[]) => confirmed.push(ids),
        onCancel: () => { cancelled += 1; },
      }),
    ),
  );
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

function rowLabels(): string[] {
  return Array.from(document.querySelectorAll("label")).map(
    (l) => l.querySelector("span")?.textContent ?? "",
  );
}

function button(key: string): HTMLElement {
  const label = i18n.t(key);
  const el = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`no button "${label}"`);
  return el;
}

describe("MailAttachmentPickDialog", () => {
  it("lists real attachments before inline ones and pre-ticks only the real ones", () => {
    render();

    expect(rowLabels()).toEqual(["invoice.pdf", "notes.txt", "logo.png"]);
    expect(checkboxes().map((c) => c.checked)).toEqual([true, true, false]);
  });

  it("marks the inline image so a signature logo is recognisable", () => {
    render();
    const inlineRow = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.includes("logo.png"));
    expect(inlineRow?.textContent).toContain(i18n.t("tasks.attachInline"));
  });

  it("confirms the ticked ids in list order", () => {
    render();
    act(() => checkboxes()[2].click()); // add the inline logo
    act(() => checkboxes()[1].click()); // drop notes.txt
    act(() => button("tasks.attachConfirm").click());

    expect(confirmed).toEqual([["invoice", "logo"]]);
  });

  it("creates without files when 'without attachments' is picked", () => {
    render();
    act(() => button("tasks.attachSkip").click());
    expect(confirmed).toEqual([[]]);
  });

  it("toggles the whole list from the select-all button", () => {
    render();
    act(() => button("tasks.attachSelectAll").click());
    expect(checkboxes().every((c) => c.checked)).toBe(true);

    // With everything ticked the same button clears the selection instead.
    act(() => button("tasks.attachSelectNone").click());
    expect(checkboxes().some((c) => c.checked)).toBe(false);
  });

  it("cancels on Escape without creating anything", () => {
    render();
    act(() => {
      document.querySelector('[role="dialog"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(cancelled).toBe(1);
    expect(confirmed).toEqual([]);
  });
});
