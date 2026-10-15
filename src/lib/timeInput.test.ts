import { describe, it, expect } from "vitest";
import { parseTimeInput, timeOptions } from "./timeInput";

describe("parseTimeInput", () => {
  it.each([
    ["9", "09:00"],
    ["09", "09:00"],
    ["23", "23:00"],
    ["930", "09:30"],
    ["0930", "09:30"],
    ["1745", "17:45"],
    ["9:30", "09:30"],
    ["9.30", "09:30"],
    ["9h30", "09:30"],
    ["9h", "09:00"],
    ["9 Uhr", "09:00"],
    [" 17:05 ", "17:05"],
    ["0:00", "00:00"],
  ])("reads %j as %s", (text, expected) => {
    expect(parseTimeInput(text)).toBe(expected);
  });

  it.each([
    ["9pm", "21:00"],
    ["9 PM", "21:00"],
    ["9:30pm", "21:30"],
    ["9.30 p.m.", "21:30"],
    ["9:30 a", "09:30"],
    ["12am", "00:00"],
    ["12:15 AM", "00:15"],
    ["12pm", "12:00"],
  ])("reads the 12-hour form %j as %s", (text, expected) => {
    expect(parseTimeInput(text)).toBe(expected);
  });

  it("reads the locale's own day periods", () => {
    const de = { am: "vorm.", pm: "nachm." };
    expect(parseTimeInput("5:45 nachm.", de)).toBe("17:45");
    expect(parseTimeInput("8:00 Vorm.", de)).toBe("08:00");
    expect(parseTimeInput("9:30", de)).toBe("09:30");
  });

  it.each(["", "abc", "24", "960", "9:5", "25:00", "13pm", "0am", "12345", "pm", "9:30:00"])("rejects %j", (text) => {
    expect(parseTimeInput(text)).toBeNull();
  });
});

describe("timeOptions", () => {
  it("lists the day in quarter hours", () => {
    const slots = timeOptions("09:00");
    expect(slots).toHaveLength(96);
    expect(slots.slice(0, 3)).toEqual(["00:00", "00:15", "00:30"]);
    expect(slots[95]).toBe("23:45");
  });

  it("keeps an off-grid value in order so the list can open on it", () => {
    const slots = timeOptions("09:05");
    expect(slots).toHaveLength(97);
    expect(slots.slice(36, 39)).toEqual(["09:00", "09:05", "09:15"]);
  });
});
