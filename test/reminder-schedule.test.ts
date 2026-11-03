import { describe, it, expect } from "vitest";
import {
  buildSchedule,
  followingRun,
  parseReminderTime,
  assertRequestedReminderTime,
} from "../server/reminder-schedule.js";
const now = Date.parse("2026-10-31T16:00:00Z");
describe("reminder schedules", () => {
  it("resolves tonight using the user's date when UTC is already tomorrow", () => {
    const evening = Date.parse("2026-11-02T00:49:59Z");
    const fields = buildSchedule({ localTime: "20:30", day: "today" }, "America/New_York", evening);
    expect(fields.nextRunAt).toBe(Date.parse("2026-11-02T01:30:00Z"));
    expect(() => assertRequestedReminderTime("Remind me at 8:30 pm to check the NIRVE data", fields, "America/New_York", evening)).not.toThrow();
    const wrongDay = buildSchedule({ at: "2026-11-02T20:30:00" }, "America/New_York", evening);
    expect(() => assertRequestedReminderTime("Remind me at 8:30 pm to check the NIRVE data", wrongDay, "America/New_York", evening)).toThrow(/conflicts/);
  });
  it("checks wider phrasings and resolves a bare hour to its next upcoming occurrence", () => {
    const tz = "America/New_York";
    const evening = Date.parse("2026-11-03T00:12:00Z"); // Mon Nov 2, 7:12 PM EST
    const ninePm = buildSchedule({ localTime: "21:00", day: "today" }, tz, evening);
    const nineAmTomorrow = buildSchedule({ localTime: "09:00", day: "tomorrow" }, tz, evening);
    for (const request of [
      "Remind me at 9pm that I need to send the report",
      "Can you remind me at 9 p.m. about the report",
      "please set a reminder at 9pm: send the report",
      "remind me at 9 that I need to send the report",
      "remind me tonight at 9 to send the report",
    ]) {
      expect(() => assertRequestedReminderTime(request, ninePm, tz, evening)).not.toThrow();
      expect(() => assertRequestedReminderTime(request, nineAmTomorrow, tz, evening)).toThrow(/localTime="21:00" and day="today"/);
    }
    const morning = Date.parse("2026-11-02T12:00:00Z"); // 7:00 AM EST
    const nineAm = buildSchedule({ localTime: "09:00", day: "today" }, tz, morning);
    expect(() => assertRequestedReminderTime("remind me at 9 to stretch", nineAm, tz, morning)).not.toThrow();
    // Later dates or day-parts are not clock-only; the guard stays out of the way.
    for (const request of [
      "remind me at 9pm to call mom tomorrow",
      "remind me at 9 in the morning to stretch",
      "remind me at 9pm on Friday to submit",
      "remind me tonight at 1am to sleep",
      "remind me at 7 to stretch",
    ]) {
      expect(() => assertRequestedReminderTime(request, nineAmTomorrow, tz, evening)).not.toThrow();
    }
  });
  it("preserves explicit tomorrow requests and refuses to roll a past clock to tomorrow", () => {
    const evening = Date.parse("2026-11-02T00:49:59Z");
    const tomorrow = buildSchedule({ localTime: "20:30", day: "tomorrow" }, "America/New_York", evening);
    expect(tomorrow.nextRunAt).toBe(Date.parse("2026-11-03T01:30:00Z"));
    expect(() => assertRequestedReminderTime("Remind me tomorrow at 8:30 pm to check the data", tomorrow, "America/New_York", evening)).not.toThrow();
    expect(() => buildSchedule({ localTime: "18:30" }, "America/New_York", evening)).toThrow(/future/);
    expect(() => buildSchedule({ localTime: "20:30", at: "2026-11-02T20:30" }, "America/New_York", evening)).toThrow(/not both/);
    expect(() => buildSchedule({ day: "today", afterSeconds: 60 }, "America/New_York", evening)).toThrow(/requires localTime/);
  });
  it("resolves local tomorrow across year boundaries and validates clock values", () => {
    const evening = Date.parse("2027-01-01T01:00:00Z");
    expect(buildSchedule({ localTime: "09:00", day: "tomorrow" }, "America/New_York", evening).nextRunAt).toBe(Date.parse("2027-01-01T14:00:00Z"));
    for (const localTime of ["24:00", "12:60", "8:30 PM"]) expect(() => buildSchedule({ localTime }, "America/New_York", evening)).toThrow(/24-hour/);
    expect(() => buildSchedule({ localTime: "09:00" }, null, evening)).toThrow(/timezone/);
  });
  it("supports relative one-time reminders without a timezone", () => {
    const s = buildSchedule({ afterSeconds: 1800 }, null, now);
    expect(s.scheduleKind).toBe("once");
    expect(s.nextRunAt).toBe(now + 1800000);
    expect(followingRun(s, s.nextRunAt!)).toBeNull();
  });
  it("interprets local wall time in the user's zone, not the server's", () => {
    expect(
      buildSchedule({ at: "2026-11-02T09:00" }, "America/New_York", now)
        .nextRunAt,
    ).toBe(Date.parse("2026-11-02T14:00:00Z"));
    expect(() => buildSchedule({ at: "2026-11-02T09:00" }, null, now)).toThrow(
      /timezone/,
    );
  });
  it("rejects missing, conflicting, past, and impossible schedules", () => {
    for (const s of [
      {},
      { afterSeconds: 0 },
      { at: "2026-02-30T09:00" },
      { at: "2026-01-01T09:00" },
      { afterSeconds: 5, schedule: "0 9 * * *" },
      { everySeconds: 5 },
    ])
      expect(() => buildSchedule(s, "America/New_York", now)).toThrow();
  });
  it("requires clarification for ambiguous/nonexistent local times", () => {
    expect(() =>
      parseReminderTime("2026-11-01T01:30", "America/New_York"),
    ).toThrow(/twice/);
    expect(() =>
      parseReminderTime("2027-03-14T02:30", "America/New_York"),
    ).toThrow(/does not exist/);
    expect(
      parseReminderTime("2026-11-01T01:30-05:00", "America/New_York"),
    ).toBe(Date.parse("2026-11-01T06:30Z"));
  });
  it("detects half-hour daylight-saving ambiguity as well", () => {
    expect(() =>
      parseReminderTime("2027-04-04T01:45", "Australia/Lord_Howe"),
    ).toThrow(/twice/);
  });
  it("supports weekday, selected-day, weekly, and monthly patterns", () => {
    for (const schedule of [
      "0 9 * * 1-5",
      "0 9 * * 1,3,5",
      "0 18 * * 0",
      "0 9 1 * *",
    ]) {
      const s = buildSchedule({ schedule }, "America/New_York", now);
      expect(s.nextRunAt).toBeGreaterThan(now);
      expect(followingRun(s, s.nextRunAt!)).toBeGreaterThan(s.nextRunAt!);
    }
  });
  it("keeps elapsed intervals anchored without replaying missed occurrences", () => {
    const s = buildSchedule({ everySeconds: 10800 }, null, now);
    expect(followingRun(s, now + 10 * 3600000)).toBe(now + 12 * 3600000);
  });
  it("keeps every-other-day local time across month and DST boundaries", () => {
    const s = buildSchedule(
      { everyDays: 2, at: "2026-10-31T09:00" },
      "America/New_York",
      Date.parse("2026-10-30T10:00Z"),
    );
    expect(s.nextRunAt).toBe(Date.parse("2026-10-31T13:00Z"));
    expect(followingRun(s, s.nextRunAt!)).toBe(Date.parse("2026-11-02T14:00Z"));
    expect(followingRun(s, Date.parse("2026-11-10T18:00Z"))).toBe(
      Date.parse("2026-11-12T14:00Z"),
    );
  });
});
