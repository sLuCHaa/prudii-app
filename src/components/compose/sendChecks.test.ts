import { describe, it, expect } from "vitest";
import { countRecipients, sendBlocker } from "./sendChecks";

describe("sendBlocker", () => {
  it("asks for a recipient when To is empty, even with Cc filled", () => {
    expect(sendBlocker([], ["anna@studio-halde.de"], [], true)).toEqual({ key: "compose.enterRecipient" });
  });

  it("asks for an account to send from", () => {
    expect(sendBlocker(["anna@studio-halde.de"], [], [], false)).toEqual({ key: "compose.selectAccount" });
  });

  it("names the first malformed address in any field", () => {
    expect(sendBlocker(["anna@studio-halde.de"], [], ["Bernd <bernd@studio-halde>"], true)).toEqual({ key: "compose.invalidEmail", email: "bernd@studio-halde" });
  });

  it("lets a complete mail through", () => {
    expect(sendBlocker(['"Weber, Anna" <anna@studio-halde.de>'], ["bernd@studio-halde.de"], [], true)).toBeNull();
  });
});

describe("countRecipients", () => {
  it("counts every address, including several pasted into one chip", () => {
    expect(countRecipients(["anna@studio-halde.de, bernd@studio-halde.de"], ['"Weber, Carla" <carla@studio-halde.de>'], ["dora@studio-halde.de"])).toBe(4);
  });
});
