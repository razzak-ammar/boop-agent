import { describe, expect, it, vi } from "vitest";
import { searchCalendarEvents, type CalendarRead } from "../server/calendar/search.js";
const now = Date.parse("2026-11-02T04:37:00Z");
const zone = "America/New_York";
const ok = (data: unknown) => ({ successful: true, data });
const event = (id: string, title: string, date: string) => ({ id, summary: title, start: { date }, end: { date }, description: "", htmlLink: `https://calendar.google.com/event?eid=${id}` });
const examEvents = [
  event("late-quiz", "MATH 347 QUIZ", "2026-12-09"),
  event("biol", "MIDTERM (BIOL 336)", "2026-11-12"),
  event("chem", "MIDTERM (CHEM 340)", "2026-11-23"),
  event("math", "MIDTERM (MATH 347)", "2026-12-02"),
  event("first-quiz", "MATH 347 QUIZ", "2026-11-11"),
  event("second-quiz", "MATH 347 QUIZ", "2026-11-18"),
];
describe("calendar search coverage and ordering", () => {
  it("finds the first quiz and first midterm across calendars without a Boolean provider query", async () => {
    const read = vi.fn<CalendarRead>().mockImplementation(async (tool, args) => tool === "GOOGLECALENDAR_LIST_CALENDARS"
      ? ok({ calendars: [{ id: "blocks", summary: "Time Blocks" }, { id: "school", summary: "Academics", hidden: true }] })
      : ok({ items: args.calendarId === "school" ? examEvents : [event("study", "Study BIOL 336", "2026-11-03")] }));
    const result = await searchCalendarEvents({ terms: ["midterm", "quiz"] }, read, zone, now);
    expect(result.complete).toBe(true);
    expect(result.totalMatches).toBe(6);
    expect(result.events[0].title).toBe("MATH 347 QUIZ");
    expect(result.events[0].start).toBe("2026-11-11");
    expect(result.earliestByTerm.midterm?.start).toBe("2026-11-12");
    expect(result.earliestByTerm.quiz?.start).toBe("2026-11-11");
    expect(result.calendarsChecked.map(c => c.name).sort()).toEqual(["Academics", "Time Blocks"]);
    for (const [tool, args] of read.mock.calls) {
      if (tool === "GOOGLECALENDAR_EVENTS_LIST") {
        expect(args).not.toHaveProperty("query"); expect(args).not.toHaveProperty("q");
        expect(args.singleEvents).toBe(true);
        expect(args.fields).toContain("nextPageToken");
      }
    }
  });
  it("follows both calendar and event pagination, including empty pages with continuation", async () => {
    const read = vi.fn<CalendarRead>().mockImplementation(async (tool, args) => {
      if (tool === "GOOGLECALENDAR_LIST_CALENDARS") return args.page_token ? ok({ calendars: [{ id: "school", summary: "Academics" }] }) : ok({ calendars: [], next_page_token: "cal-page" });
      return args.pageToken ? ok({ items: [examEvents[1], examEvents[1]] }) : ok({ items: [], nextPageToken: "event-page" });
    });
    const result = await searchCalendarEvents({ terms: ["midterm"] }, read, zone, now);
    expect(result.complete).toBe(true);
    expect(result.totalMatches).toBe(1);
    expect(read.mock.calls.map(([, args]) => args.pageToken ?? args.page_token)).toContain("cal-page");
    expect(read.mock.calls.map(([, args]) => args.pageToken ?? args.page_token)).toContain("event-page");
  });
  it("does not let recurring lectures crowd a later-page exam out of the result", async () => {
    const read = vi.fn<CalendarRead>().mockImplementation(async (tool, args) => tool === "GOOGLECALENDAR_LIST_CALENDARS"
      ? ok({ calendars: [{ id: "school", summary: "Academics" }] })
      : args.pageToken ? ok({ items: [examEvents[1]] }) : ok({ items: Array.from({ length: 250 }, (_, i) => event(`lecture-${i}`, "Lecture", "2026-11-03")), nextPageToken: "more" }));
    const result = await searchCalendarEvents({ terms: ["midterm"] }, read, zone, now);
    expect(result.complete).toBe(true);
    expect(result.events[0].title).toBe("MIDTERM (BIOL 336)");
    expect(result.calendarsChecked[0].eventsScanned).toBe(251);
  });
  it("keeps all-day dates intact and matches descriptions without returning bulky metadata", async () => {
    const read: CalendarRead = async tool => tool === "GOOGLECALENDAR_LIST_CALENDARS"
      ? ok({ calendars: [{ id: "school", summary: "Academics" }] })
      : ok({ items: [{ ...event("hidden-title", "BIOL 336", "2026-11-12"), description: `Midterm. ${"details ".repeat(2000)}` }] });
    const result = await searchCalendarEvents({ terms: ["midterm"] }, read, "America/Los_Angeles", now);
    expect(result.events[0]).toMatchObject({ allDay: true, start: "2026-11-12", localStart: "2026-11-12" });
    expect(result.events[0].description!.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(result).length).toBeLessThan(2500);
  });
  it("marks a partial failure as incomplete rather than proving no events exist", async () => {
    const read: CalendarRead = async tool => tool === "GOOGLECALENDAR_LIST_CALENDARS"
      ? ok({ calendars: [{ id: "school", summary: "Academics" }] })
      : { successful: false, error: "No access" };
    const result = await searchCalendarEvents({ terms: ["midterm"] }, read, zone, now);
    expect(result.complete).toBe(false);
    expect(result.calendarsChecked[0].issue).toBeTruthy();
    expect(result.events).toEqual([]);
  });
  it("does not fall back to primary if an explicitly named calendar is missing", async () => {
    const read = vi.fn<CalendarRead>().mockResolvedValue(ok({ calendars: [{ id: "primary", summary: "Personal" }] }));
    const result = await searchCalendarEvents({ calendarNames: ["Academics"] }, read, zone, now);
    expect(result.complete).toBe(false);
    expect(result.issues[0]).toContain("not found");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("ignores cancelled events, detects stuck pages, and reports output truncation", async () => {
    const read: CalendarRead = async tool => tool === "GOOGLECALENDAR_LIST_CALENDARS"
      ? ok({ calendars: [{ id: "school", summary: "Academics" }] })
      : ok({ items: [...examEvents, { ...event("cancelled", "MIDTERM", "2026-11-03"), status: "cancelled" }], nextPageToken: "stuck" });
    const result = await searchCalendarEvents({ terms: ["midterm", "quiz"], limit: 1 }, read, zone, now);
    expect(result.complete).toBe(false);
    expect(result.resultsTruncated).toBe(true);
    expect(result.totalMatches).toBe(6);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("first-quiz");
  });
  it("rejects Boolean query strings and invalid windows before contacting the provider", async () => {
    const read = vi.fn<CalendarRead>();
    await expect(searchCalendarEvents({ terms: ["midterm OR quiz"] }, read, zone, now)).rejects.toThrow("separate array");
    await expect(searchCalendarEvents({ start: "2026-11-03T00:00", end: "2026-11-02T00:00" }, read, zone, now)).rejects.toThrow("after start");
    expect(read).not.toHaveBeenCalled();
  });
});
