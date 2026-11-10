import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS, describeQuietHours, inQuietHours, minutesUntilQuiet, parseQuietHours, updateQuietHours,
} from "../server/quiet-hours.js";
import { taskTiming } from "../server/tasks/timing.js";
import { decideFreeTime } from "../server/freetime/gate.js";

describe("quiet hours", () => {
  const late = { start: "23:00", end: "07:00", enabled: true };

  it("handles overnight and same-day windows", () => {
    expect(inQuietHours("23:30", late)).toBe(true);
    expect(inQuietHours("06:59", late)).toBe(true);
    expect(inQuietHours("07:00", late)).toBe(false);
    expect(inQuietHours("22:30", late)).toBe(false);
    const nap = { start: "13:00", end: "15:00", enabled: true };
    expect(inQuietHours("14:00", nap)).toBe(true);
    expect(inQuietHours("15:00", nap)).toBe(false);
    expect(inQuietHours("03:00", { ...late, enabled: false })).toBe(false);
  });

  it("counts minutes until quiet hours start", () => {
    expect(minutesUntilQuiet("21:00", late)).toBe(120);
    expect(minutesUntilQuiet("21:00", { ...late, enabled: false })).toBe(Infinity);
  });

  it("validates changes and normalizes loose times", () => {
    expect(updateQuietHours(DEFAULT_QUIET_HOURS, { start: "23", end: "7:30" })).toEqual({ start: "23:00", end: "07:30", enabled: true });
    expect(updateQuietHours(DEFAULT_QUIET_HOURS, { start: "25:00" })).toMatch(/start/);
    expect(updateQuietHours(DEFAULT_QUIET_HOURS, { start: "08:00" })).toMatch(/same time/);
    expect(updateQuietHours(DEFAULT_QUIET_HOURS, { enabled: false })).toEqual({ ...DEFAULT_QUIET_HOURS, enabled: false });
  });

  it("falls back to the default for a missing or broken setting", () => {
    expect(parseQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(parseQuietHours("{oops")).toEqual(DEFAULT_QUIET_HOURS);
    expect(parseQuietHours(JSON.stringify(late))).toEqual(late);
  });

  it("describes itself for the user", () => {
    expect(describeQuietHours(DEFAULT_QUIET_HOURS)).toBe("10 PM to 8 AM");
    expect(describeQuietHours({ start: "23:30", end: "07:00", enabled: true })).toBe("11:30 PM to 7 AM");
    expect(describeQuietHours({ ...late, enabled: false })).toBe("off");
  });

  it("is what hourly task nudges and free-time check-ins obey", () => {
    const now = Date.UTC(2026, 10, 9, 12);
    const hourly = { importance: "normal" as const, cadenceDays: 1, cadenceHours: 1, createdAt: now - 5 * 3600000, nudgeCount: 0 };
    // 22:30 is quiet by default but not with 23:00-07:00.
    expect(taskTiming(hourly, "2026-11-09", now, "22:30").dueForNudge).toBe(false);
    expect(taskTiming(hourly, "2026-11-09", now, "22:30", late).dueForNudge).toBe(true);
    const free = { now, events: [], handled: new Set<string>(), hasWork: true };
    expect(decideFreeTime({ ...free, clock: "22:30" }).reason).toBe("quiet hours");
    expect(decideFreeTime({ ...free, clock: "22:30", quiet: late }).trigger).toBe("heartbeat");
  });
});
