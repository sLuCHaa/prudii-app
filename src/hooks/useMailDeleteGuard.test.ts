import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../lib/i18n";
import type { Account } from "../types";

const { count, danger } = vi.hoisted(() => ({ count: vi.fn(), danger: vi.fn() }));

vi.mock("../lib/tauri", async (original) => ({
  ...(await original<typeof import("../lib/tauri")>()),
  countPop3ServerDeletes: count,
}));
vi.mock("../components/ui/DialogProvider", () => ({ useDialog: () => ({ danger }) }));

import { useMailDeleteGuard } from "./useMailDeleteGuard";
import { useAppStore } from "../stores/appStore";

const account = (id: string, incoming_protocol: "imap" | "pop3") =>
  ({ id, email: "anna@studio-halde.example", incoming_protocol, pop3_delete_with_local: true }) as Account;
const popMail = { id: "m1", account_id: "pop" };

let root: Root;
let guards: ReturnType<typeof useMailDeleteGuard>[];

function Probe({ index }: { index: number }) {
  guards[index] = useMailDeleteGuard();
  return null;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  count.mockReset().mockResolvedValue(0);
  danger.mockReset().mockResolvedValue(true);
  useAppStore.setState({ accounts: [account("pop", "pop3"), account("imap", "imap")] });
  guards = [];
  root = createRoot(document.createElement("div"));
  act(() => root.render([0, 1].map((index) => createElement(Probe, { key: index, index }))));
});

afterEach(async () => {
  await settle();
  act(() => root.unmount());
});

describe("a second delete of the same mail", () => {
  it("does nothing until the first trash call has settled, from any component", async () => {
    const counted = deferred<number>();
    const trashed = deferred<void>();
    count.mockReturnValue(counted.promise);
    const run = vi.fn(() => trashed.promise);
    guards[0]([popMail], run);
    guards[0]([popMail], run);
    guards[1]([{ id: "m2", account_id: "pop" }, popMail], run);
    counted.resolve(0);
    await settle();
    guards[1]([popMail], run);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    trashed.resolve();
    await settle();
    guards[0]([popMail], run);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("is possible again after a cancelled warning", async () => {
    count.mockResolvedValue(1);
    danger.mockResolvedValueOnce(false);
    const run = vi.fn();
    guards[0]([popMail], run);
    await settle();
    expect(run).not.toHaveBeenCalled();
    guards[0]([popMail], run);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is possible again after a failed trash call", async () => {
    const failed = deferred<void>();
    const run = vi.fn(() => failed.promise);
    guards[0]([popMail], () => run().catch(() => {}));
    await settle();
    failed.reject(new Error("offline"));
    await settle();
    guards[0]([popMail], () => run().catch(() => {}));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("the accounts of the mails", () => {
  it("let unaffected mails run at once without a check", () => {
    const run = vi.fn();
    guards[0]([{ id: "m3", account_id: "imap" }], run);
    guards[0]([{ id: "m3", account_id: "imap" }], run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(count).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown account", [{ id: "m4", account_id: "gone" }]],
    ["no known account", [{ id: "m5" }]],
    ["a mixed selection", [{ id: "m6", account_id: "imap" }, { id: "m7", account_id: "pop" }]],
  ])("are checked for %s", async (_name, mails) => {
    const run = vi.fn();
    guards[0](mails, run);
    expect(run).not.toHaveBeenCalled();
    await settle();
    expect(count).toHaveBeenCalledWith(mails.map((m) => m.id));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
