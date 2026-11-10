import { describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { busyEvents, parseBusyCalendars } from "../server/freetime/checkin.js";
import type { CalendarMatch } from "../server/calendar/search.js";

const event = (calendarName: string, title: string, extra: Partial<CalendarMatch> = {}): CalendarMatch => ({
  id: title, calendarId: calendarName, calendarName, title,
  start: "2026-11-09T17:00:00-05:00", end: "2026-11-09T18:20:00-05:00",
  allDay: false, localStart: "2026-11-09T17:00", matchedTerms: [], ...extra,
});

describe("busy calendars", () => {
  const events = [
    event("Academics", "CHEM 340 | Lecture"),
    event("Lab Availability", "Someone's availability"),
    event("Meetings", "Lab meeting"),
    event("Academics", "Exam week", { allDay: true, start: "2026-11-09", end: "2026-11-10" }),
  ];

  it("reads the saved setting, case-insensitively, and treats empty as unset", () => {
    expect(parseBusyCalendars('["Academics","Meetings"]')).toEqual(new Set(["academics", "meetings"]));
    expect(parseBusyCalendars("[]")).toBeNull();
    expect(parseBusyCalendars(null)).toBeNull();
    expect(parseBusyCalendars("not json")).toBeNull();
  });

  it("only counts timed events on the picked calendars", () => {
    const busy = busyEvents(events, parseBusyCalendars('["academics","Meetings"]'));
    expect(busy.map((e) => e.title)).toEqual(["CHEM 340 | Lecture", "Lab meeting"]);
  });

  it("counts every calendar when nothing is picked, but never all-day items", () => {
    expect(busyEvents(events, null).map((e) => e.title)).toEqual(["CHEM 340 | Lecture", "Someone's availability", "Lab meeting"]);
  });
});
