import { describe, it, expect } from "vitest";
import { composeInputs } from "./composeInputs";
import type { ComposeInitData } from "./ComposeModal";
import type { AppSettings } from "../../types";

const store = {
  selectedAccountId: "acc2",
  mailtoParams: { to: ["anna@studio-halde.example"], cc: [], bcc: [], subject: "Hallo", body: "" },
  aiReplyText: "Danke, passt.",
};

const initData = (patch: Partial<ComposeInitData> = {}): ComposeInitData => ({
  mode: "reply",
  originalMail: null,
  accounts: [],
  appSettings: {} as AppSettings,
  selectedAccountId: null,
  darkMode: false,
  ...patch,
});

describe("composeInputs", () => {
  it("keeps a docked form on its own data while the main window opens other composes", () => {
    expect(composeInputs(initData(), store)).toEqual({ selectedAccountId: null, mailtoParams: null, aiReplyText: null });
  });

  it("uses what the form was opened with", () => {
    const own = initData({ selectedAccountId: "acc1", aiReplyText: "Gern.", mailtoParams: null });
    expect(composeInputs(own, store)).toEqual({ selectedAccountId: "acc1", mailtoParams: null, aiReplyText: "Gern." });
  });

  it("reads the store only for a form opened without data", () => {
    expect(composeInputs(undefined, store)).toBe(store);
  });
});
