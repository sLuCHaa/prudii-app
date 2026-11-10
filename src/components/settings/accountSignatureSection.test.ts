import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import type { Account, Signature } from "../../types";

vi.mock("../../lib/tauri", () => ({
  listSignatures: vi.fn(),
  listAccounts: vi.fn(),
}));
vi.mock("./SignaturePreview", () => ({
  SignaturePreview: ({ html }: { html: string }) => createElement("div", { "data-testid": "sig-preview" }, html),
}));

import { listSignatures, listAccounts } from "../../lib/tauri";
import { AccountSignatureSection } from "./AccountSignatureSection";

const sig = (id: string, name: string): Signature => ({ id, name, html: `<div>${name}</div>`, text: name, created_at: "", updated_at: "" });
const acc = (id: string, display_name: string, signature_id: string | null) =>
  ({ id, display_name, email: `${id}@studio-halde.example`, color: "#3b82f6", signature_id }) as Account;

const SIGNATURES = [sig("s2", "Privat"), sig("s1", "Studio Halde")];
const ACCOUNTS = [acc("a1", "Anna Weber", "s1"), acc("a2", "Studio Halde Info", "s1"), acc("a3", "Privat", "s2")];

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;
const onSignatureChange = vi.fn<(id: string | null) => void>();
const onEdit = vi.fn<(id: string) => void>();

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onSignatureChange.mockReset();
  onEdit.mockReset();
  vi.mocked(listSignatures).mockResolvedValue(SIGNATURES);
  vi.mocked(listAccounts).mockResolvedValue(ACCOUNTS);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

async function render(accountId: string, signatureId: string | null) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AccountSignatureSection, {
          accountId,
          signatureId,
          onSignatureChange,
          onCompose: true,
          onReply: true,
          onComposeChange: () => {},
          onReplyChange: () => {},
          onEdit,
        }),
      ),
    );
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const select = () => host.querySelector("select")!;
const preview = () => host.querySelector("[data-testid='sig-preview']");
const shared = () => host.querySelector("[data-signature-shared]");
const editButton = () =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === i18n.t("settings.account.signatureEditInTab"));

function choose(value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select(), value);
  act(() => {
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("AccountSignatureSection", () => {
  it("offers every signature and no signature", async () => {
    await render("a1", "s1");
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual([
      i18n.t("settings.account.signatureNone"),
      "Privat",
      "Studio Halde",
    ]);
    expect(select().value).toBe("s1");
  });

  it("reports the chosen signature, and null for none", async () => {
    await render("a1", "s1");
    choose("s2");
    expect(onSignatureChange).toHaveBeenLastCalledWith("s2");
    choose("");
    expect(onSignatureChange).toHaveBeenLastCalledWith(null);
  });

  it("names the other accounts that share the signature", async () => {
    await render("a1", "s1");
    expect(shared()!.textContent).toBe(i18n.t("settings.account.signatureSharedWith", { accounts: "Studio Halde Info" }));
  });

  it("counts the accounts of a signature that is only being chosen", async () => {
    await render("a3", "s1");
    expect(shared()!.textContent).toBe(i18n.t("settings.account.signatureSharedWith", { accounts: "Anna Weber, Studio Halde Info" }));
  });

  it("shows no sharing hint for a signature used alone", async () => {
    await render("a3", "s2");
    expect(shared()).toBeNull();
  });

  it("previews the chosen signature", async () => {
    await render("a1", "s1");
    expect(preview()!.textContent).toBe("<div>Studio Halde</div>");
  });

  it("hides preview and edit button without a signature", async () => {
    await render("a1", null);
    expect(select().value).toBe("");
    expect(preview()).toBeNull();
    expect(editButton()).toBeUndefined();
  });

  it("treats a signature that no longer exists as none", async () => {
    await render("a1", "gone");
    expect(select().value).toBe("");
    expect(preview()).toBeNull();
  });

  it("hands the signature over for editing", async () => {
    await render("a1", "s1");
    act(() => editButton()!.click());
    expect(onEdit).toHaveBeenCalledWith("s1");
  });
});
