import { describe, it, expect } from "vitest";
import {
  buildSchedule,
  followingRun,
  parseReminderTime,
} from "../server/reminder-schedule.js";
const now = Date.parse("2026-10-31T16:00:00Z");
describe("reminder schedules", () => {
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
