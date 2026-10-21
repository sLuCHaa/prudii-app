import { describe, it, expect } from "vitest";
import { countRecipients, sendBlocker } from "./sendChecks";

describe("sendBlocker", () => {
  it("asks for a recipient when To is empty, even with Cc filled", () => {
    expect(sendBlocker([], ["anna@messtex.de"], [], true)).toEqual({ key: "compose.enterRecipient" });
  });

  it("asks for an account to send from", () => {
    expect(sendBlocker(["anna@messtex.de"], [], [], false)).toEqual({ key: "compose.selectAccount" });
  });

  it("names the first malformed address in any field", () => {
    expect(sendBlocker(["anna@messtex.de"], [], ["Bernd <bernd@messtex>"], true)).toEqual({ key: "compose.invalidEmail", email: "bernd@messtex" });
  });

  it("lets a complete mail through", () => {
    expect(sendBlocker(['"Weber, Anna" <anna@messtex.de>'], ["bernd@messtex.de"], [], true)).toBeNull();
  });
});

describe("countRecipients", () => {
  it("counts every address, including several pasted into one chip", () => {
    expect(countRecipients(["anna@messtex.de, bernd@messtex.de"], ['"Weber, Carla" <carla@messtex.de>'], ["dora@messtex.de"])).toBe(4);
  });
});
