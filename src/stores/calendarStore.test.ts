import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./appStore";

describe("calendar view state", () => {
  beforeEach(() => {
    useAppStore.setState({ showCalendar: false, showTasks: false, eventEditor: null });
  });

  it("is exclusive with the other views", () => {
    useAppStore.getState().setShowCalendar(true);
    expect(useAppStore.getState().showCalendar).toBe(true);
    useAppStore.getState().setShowTasks(true);
    expect(useAppStore.getState().showCalendar).toBe(false);
    useAppStore.getState().setShowCalendar(true);
    expect(useAppStore.getState().showTasks).toBe(false);
    useAppStore.getState().setSelectedFolderId("f1");
    expect(useAppStore.getState().showCalendar).toBe(false);
  });

  it("opens an event on its day", () => {
    useAppStore.getState().openEventById("e1", "2026-10-15T09:00:00", "2026-10-15");
    const s = useAppStore.getState();
    expect(s.showCalendar).toBe(true);
    expect(s.calendarAnchor).toBe("2026-10-15");
    expect(s.eventEditor).toEqual({ mode: "edit", eventId: "e1", occurrenceKey: "2026-10-15T09:00:00" });
  });

  it("opens a draft and jumps to its day", () => {
    useAppStore.getState().openNewEvent({ title: "From mail", times: { all_day: true, start: "2026-11-02", end: "2026-11-03" } });
    const s = useAppStore.getState();
    expect(s.calendarAnchor).toBe("2026-11-02");
    expect(s.eventEditor?.mode).toBe("new");
  });

  it("remembers the chosen view", () => {
    useAppStore.getState().setCalendarView("month");
    expect(localStorage.getItem("prudii-calendar-view")).toBe("month");
  });
});
