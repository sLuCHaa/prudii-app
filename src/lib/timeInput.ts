const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Typed time ("9", "930", "9:30", "9h30", "9:30 pm", "9 Uhr") -> "HH:mm", or null.
 * `dayPeriods` are the locale's own AM/PM labels (de: "vorm."/"nachm."), as the field displays them.
 */
export function parseTimeInput(text: string, dayPeriods?: { am: string; pm: string }): string | null {
  let s = text.trim().toLowerCase();
  if (dayPeriods) {
    s = s.replace(dayPeriods.pm.toLowerCase(), "pm").replace(dayPeriods.am.toLowerCase(), "am");
  }
  s = s.replace(/\s+/g, "");
  let meridiem: "am" | "pm" | null = null;
  const m = /^(.*?)([ap])\.?(?:m\.?)?$/.exec(s);
  if (m) {
    meridiem = m[2] === "a" ? "am" : "pm";
    s = m[1];
  }
  s = s.replace(/(?:uhr|h)$/, "");

  let h: number;
  let min: number;
  const parts = /^(\d{1,2})[:.h](\d{2})$/.exec(s);
  if (parts) {
    h = Number(parts[1]);
    min = Number(parts[2]);
  } else if (/^\d{1,2}$/.test(s)) {
    h = Number(s);
    min = 0;
  } else if (/^\d{3,4}$/.test(s)) {
    h = Number(s.slice(0, -2));
    min = Number(s.slice(-2));
  } else {
    return null;
  }
  if (min > 59) return null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

/** Quarter-hour slots of a day, plus `value` in order when it sits off the grid. */
export function timeOptions(value: string): string[] {
  const slots = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
  if (/^\d{2}:\d{2}$/.test(value) && !slots.includes(value)) {
    slots.push(value);
    slots.sort();
  }
  return slots;
}
