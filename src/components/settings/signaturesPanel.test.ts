import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import type { Account, Signature } from "../../types";

const { danger } = vi.hoisted(() => ({ danger: vi.fn() }));

vi.mock("../../lib/tauri", () => ({
  listSignatures: vi.fn(),
  saveSignature: vi.fn(),
  duplicateSignature: vi.fn(),
  deleteSignature: vi.fn(),
  listAccounts: vi.fn(),
}));
vi.mock("../ui/DialogProvider", () => ({ useDialog: () => ({ danger, isOpen: false }) }));
vi.mock("./SignatureEditor", () => ({
  SignatureEditor: ({ htmlValue, onChange }: { htmlValue: string; onChange: (html: string, text: string) => void }) =>
    createElement("textarea", {
      "data-testid": "sig-editor",
      value: htmlValue,
      onChange: (e: { target: { value: string } }) => onChange(e.target.value, e.target.value),
    }),
}));

import { listSignatures, saveSignature, duplicateSignature, deleteSignature, listAccounts } from "../../lib/tauri";
import { SignaturesPanel } from "./SignaturesPanel";

const list = vi.mocked(listSignatures);
const save = vi.mocked(saveSignature);
const duplicate = vi.mocked(duplicateSignature);
const remove = vi.mocked(deleteSignature);
const accountsCall = vi.mocked(listAccounts);

const sig = (id: string, name: string): Signature => ({ id, name, html: `<div>${name}</div>`, text: name, created_at: "", updated_at: "" });
const acc = (id: string, display_name: string, signature_id: string | null) =>
  ({ id, display_name, email: `${id}@studio-halde.example`, color: "#3b82f6", signature_id }) as Account;

const SIGNATURES = [sig("s2", "Privat"), sig("s1", "Studio Halde")];
const ACCOUNTS = [acc("a1", "Anna Weber", "s1"), acc("a2", "Studio Halde Info", "s1"), acc("a3", "Privat", "s2")];

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;
let onDirtyChange: ReturnType<typeof vi.fn<(dirty: boolean) => void>>;
let saveRef: MutableRefObject<(() => Promise<boolean>) | null>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAppStore.setState({ toasts: [] });
  onDirtyChange = vi.fn<(dirty: boolean) => void>();
  saveRef = { current: null };
  for (const mock of [list, save, duplicate, remove, accountsCall, danger]) mock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(opts: { signatures?: Signature[]; accounts?: Account[]; initial?: string | null } = {}) {
  list.mockResolvedValue(opts.signatures ?? SIGNATURES);
  accountsCall.mockResolvedValue(opts.accounts ?? ACCOUNTS);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SignaturesPanel, { initialSignatureId: opts.initial === undefined ? "s1" : opts.initial, onDirtyChange, saveRef }),
      ),
    );
  });
  await flush();
}

const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[data-signature-row]"));
const row = (name: string) => rows().find((r) => r.textContent?.startsWith(name))!;
const nameInput = () => host.querySelector<HTMLInputElement>("input[type='text']");
const ticks = () => Array.from(host.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
const buttonNamed = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function runSave() {
  let ok = false;
  await act(async () => {
    ok = await saveRef.current!();
  });
  await flush();
  return ok;
}

describe("SignaturesPanel", () => {
  it("lists each signature with the accounts that use it", async () => {
    await render();
    expect(rows().map((r) => r.textContent)).toHaveLength(2);
    expect(row("Studio Halde").textContent).toContain("Anna Weber");
    expect(row("Studio Halde").textContent).toContain("Studio Halde Info");
    expect(row("Privat").textContent).not.toContain("Anna Weber");
  });

  it("lists names with umlauts where the alphabet puts them", async () => {
    await render({ signatures: [sig("s2", "Privat"), sig("s1", "Studio Halde"), sig("s3", "Ärzte")], initial: null });
    expect(rows().map((r) => r.querySelector("span")!.textContent)).toEqual(["Ärzte", "Privat", "Studio Halde"]);
    expect(nameInput()!.value).toBe("Ärzte");
  });

  it("opens the first listed signature after a delete", async () => {
    await render({ signatures: [sig("s2", "Privat"), sig("s1", "Studio Halde"), sig("s3", "Ärzte")] });
    danger.mockResolvedValue(true);
    remove.mockResolvedValue(undefined);
    list.mockResolvedValue([sig("s2", "Privat"), sig("s3", "Ärzte")]);
    act(() => buttonNamed(i18n.t("common.delete"))!.click());
    await flush();
    expect(nameInput()!.value).toBe("Ärzte");
  });

  it("marks a signature nobody uses", async () => {
    await render({ signatures: [...SIGNATURES, sig("s3", "Unbenutzt")] });
    expect(row("Unbenutzt").textContent).toContain(i18n.t("signatures.unassigned"));
    expect(row("Privat").textContent).not.toContain(i18n.t("signatures.unassigned"));
  });

  it("opens on the first signature, or on the one asked for", async () => {
    await render({ initial: null });
    expect(nameInput()!.value).toBe("Privat");
    act(() => root.unmount());
    root = createRoot(host);
    await render({ initial: "s1" });
    expect(nameInput()!.value).toBe("Studio Halde");
  });

  it("ticks the accounts that use the signature and names the other one an account uses", async () => {
    await render();
    expect(ticks().map((t) => t.checked)).toEqual([true, true, false]);
    expect(host.textContent).toContain(i18n.t("signatures.usesOther", { name: "Privat" }));
  });

  it("saves name, content and ticked accounts", async () => {
    await render();
    save.mockResolvedValue(SIGNATURES[1]);
    act(() => ticks()[2].click());
    expect(await runSave()).toBe(true);
    expect(save).toHaveBeenCalledWith({
      id: "s1",
      name: "Studio Halde",
      html: "<div>Studio Halde</div>",
      text: "Studio Halde",
      accountIds: ["a1", "a2", "a3"],
    });
  });

  it("refuses a blank name", async () => {
    await render();
    type(nameInput()!, "   ");
    expect(await runSave()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).toContain(i18n.t("signatures.nameRequired"));
  });

  it("saves after a refused attempt once the name is there", async () => {
    await render();
    type(nameInput()!, "   ");
    expect(await runSave()).toBe(false);
    type(nameInput()!, "Büro");
    save.mockResolvedValue(sig("s1", "Büro"));
    expect(await runSave()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("reports unsaved changes and clears them once saved", async () => {
    await render();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    type(nameInput()!, "Büro");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    save.mockResolvedValue(sig("s1", "Büro"));
    list.mockResolvedValue([sig("s1", "Büro"), sig("s2", "Privat")]);
    expect(await runSave()).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(nameInput()!.value).toBe("Büro");
  });

  it("asks before leaving unsaved changes and keeps them when declined", async () => {
    await render();
    type(nameInput()!, "Büro");
    danger.mockResolvedValue(false);
    act(() => row("Privat").click());
    await flush();
    expect(danger).toHaveBeenCalledWith(expect.objectContaining({ title: i18n.t("settings.discardTitle") }));
    expect(nameInput()!.value).toBe("Büro");
  });

  it("drops the changes when the question is confirmed", async () => {
    await render();
    type(nameInput()!, "Büro");
    danger.mockResolvedValue(true);
    act(() => row("Privat").click());
    await flush();
    expect(nameInput()!.value).toBe("Privat");
  });

  it("switches without a question when nothing changed", async () => {
    await render();
    act(() => row("Privat").click());
    await flush();
    expect(danger).not.toHaveBeenCalled();
    expect(nameInput()!.value).toBe("Privat");
  });

  it("creates a new signature only when saved", async () => {
    await render();
    act(() => buttonNamed(i18n.t("signatures.new"))!.click());
    await flush();
    expect(nameInput()!.value).toBe("");
    expect(ticks().every((t) => !t.checked)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    type(nameInput()!, "Büro");
    save.mockResolvedValue(sig("s9", "Büro"));
    list.mockResolvedValue([sig("s9", "Büro"), ...SIGNATURES]);
    expect(await runSave()).toBe(true);
    expect(save).toHaveBeenCalledWith({ id: null, name: "Büro", html: "", text: "", accountIds: [] });
    expect(nameInput()!.value).toBe("Büro");
  });

  it("duplicates with the translated copy name and opens the copy", async () => {
    await render();
    const copyName = i18n.t("signatures.copyName", { name: "Studio Halde" });
    duplicate.mockResolvedValue(sig("s9", copyName));
    list.mockResolvedValue([...SIGNATURES, sig("s9", copyName)]);
    act(() => buttonNamed(i18n.t("signatures.duplicate"))!.click());
    await flush();
    expect(duplicate).toHaveBeenCalledWith("s1", copyName);
    expect(nameInput()!.value).toBe(copyName);
  });

  it("does not duplicate while changes are unsaved", async () => {
    await render();
    type(nameInput()!, "Büro");
    expect(buttonNamed(i18n.t("signatures.duplicate"))!.disabled).toBe(true);
  });

  it("names the affected accounts before deleting", async () => {
    await render();
    danger.mockResolvedValue(true);
    remove.mockResolvedValue(undefined);
    list.mockResolvedValue([sig("s2", "Privat")]);
    act(() => buttonNamed(i18n.t("common.delete"))!.click());
    await flush();
    expect(danger).toHaveBeenCalledWith(
      expect.objectContaining({
        message: i18n.t("signatures.deleteConfirmUsed", { name: "Studio Halde", accounts: "Anna Weber, Studio Halde Info" }),
      }),
    );
    expect(remove).toHaveBeenCalledWith("s1");
    expect(nameInput()!.value).toBe("Privat");
  });

  it("keeps the signature when deleting is declined", async () => {
    await render();
    danger.mockResolvedValue(false);
    act(() => buttonNamed(i18n.t("common.delete"))!.click());
    await flush();
    expect(remove).not.toHaveBeenCalled();
  });

  it("invites to create the first signature when the list is empty", async () => {
    await render({ signatures: [], accounts: ACCOUNTS.map((a) => ({ ...a, signature_id: null })), initial: null });
    expect(host.textContent).toContain(i18n.t("signatures.empty"));
    expect(nameInput()).toBeNull();
    act(() => buttonNamed(i18n.t("signatures.new"))!.click());
    await flush();
    expect(nameInput()!.value).toBe("");
  });

  const editor = () => host.querySelector<HTMLTextAreaElement>("[data-testid='sig-editor']")!;
  const restored = () => [sig("s2", "Privat"), { ...sig("s1", "Studio Halde"), html: "<div>Aus dem Backup</div>" }];
  async function listChanges(next: Signature[]) {
    list.mockResolvedValue(next);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["signatures"] });
    });
    await flush();
  }

  it("follows a list that changes underneath an untouched draft", async () => {
    await render();
    await listChanges(restored());
    expect(editor().value).toBe("<div>Aus dem Backup</div>");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the edits when the list changes underneath them", async () => {
    await render();
    type(nameInput()!, "Büro");
    await listChanges(restored());
    expect(nameInput()!.value).toBe("Büro");
    expect(editor().value).toBe("<div>Studio Halde</div>");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("moves on when the open signature disappears", async () => {
    await render();
    await listChanges([sig("s2", "Privat")]);
    expect(nameInput()!.value).toBe("Privat");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("saves once when asked twice", async () => {
    await render();
    act(() => buttonNamed(i18n.t("signatures.new"))!.click());
    await flush();
    type(nameInput()!, "Büro");
    let release!: (saved: Signature) => void;
    save.mockReturnValue(new Promise<Signature>((resolve) => { release = resolve; }));
    let both!: Promise<boolean[]>;
    act(() => {
      both = Promise.all([saveRef.current!(), saveRef.current!()]);
    });
    release(sig("s9", "Büro"));
    await act(async () => {
      expect(await both).toEqual([true, true]);
    });
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("clears its save hook and its dirty flag when it goes away", async () => {
    await render();
    type(nameInput()!, "Büro");
    expect(saveRef.current).not.toBeNull();
    act(() => root.unmount());
    expect(saveRef.current).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    root = createRoot(host);
  });
});
