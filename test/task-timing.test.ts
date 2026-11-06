import { describe, expect, it } from "vitest";
import { addDays, defaultCadence, taskTiming, windowFromAnchor } from "../server/tasks/timing.js";

const DAY = 86400000;
const now = Date.parse("2026-11-06T14:00:00Z");
const base = { importance: "normal" as const, cadenceDays: 2, nudgeCount: 0, createdAt: now - 10 * DAY };

describe("task timing", () => {
  it("builds a week-after window from a return flight", () => {
    expect(windowFromAnchor("2026-11-20", "after", 7)).toEqual({ earliest: "2026-11-20", latest: "2026-11-27" });
    expect(windowFromAnchor("2026-11-20", "before", 3)).toEqual({ earliest: "2026-11-17", latest: "2026-11-20" });
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });

  it("stays quiet until the window opens, then nudges on the first day", () => {
    const task = { ...base, earliest: "2026-11-20", latest: "2026-11-27" };
    expect(taskTiming(task, "2026-11-06", now)).toMatchObject({ state: "upcoming", opensIn: 14, dueForNudge: false });
    const opening = taskTiming({ ...task, lastNudgedAt: now - 1 * DAY }, "2026-11-20", now);
    expect(opening).toMatchObject({ state: "in_window", daysLeft: 7, dueForNudge: true, reason: "window opens today" });
  });

  it("follows the cadence inside the window and goes daily at the end", () => {
    const task = { ...base, earliest: "2026-11-01", latest: "2026-11-10" };
    expect(taskTiming({ ...task, lastNudgedAt: now - 1 * DAY }, "2026-11-06", now).dueForNudge).toBe(false);
    expect(taskTiming({ ...task, lastNudgedAt: now - 2 * DAY + 3600000 }, "2026-11-06", now).dueForNudge).toBe(true);
    expect(taskTiming({ ...task, lastNudgedAt: now - 1 * DAY }, "2026-11-10", now)).toMatchObject({ state: "last_day", dueForNudge: true });
    expect(taskTiming({ ...task, lastNudgedAt: now - 1 * DAY }, "2026-11-12", now)).toMatchObject({ state: "overdue", daysOverdue: 2, dueForNudge: true });
  });

  it("never nudges twice in one day", () => {
    const task = { ...base, latest: "2026-11-06", lastNudgedAt: now - 3600000 };
    expect(taskTiming(task, "2026-11-06", now).dueForNudge).toBe(false);
  });

  it("keeps asking about undated tasks, and a user update resets the clock", () => {
    const task = { ...base, cadenceDays: 3 };
    expect(taskTiming(task, "2026-11-06", now)).toMatchObject({ state: "undated", dueForNudge: true });
    expect(taskTiming({ ...task, lastUpdateAt: now - DAY }, "2026-11-06", now).dueForNudge).toBe(false);
    expect(taskTiming({ ...task, createdAt: now - DAY }, "2026-11-06", now).dueForNudge).toBe(false);
  });

  it("respects snoozes and escalates high-importance tasks near the end", () => {
    expect(taskTiming({ ...base, snoozedUntil: "2026-11-09" }, "2026-11-06", now)).toMatchObject({ state: "snoozed", dueForNudge: false });
    expect(taskTiming({ ...base, snoozedUntil: "2026-11-06" }, "2026-11-06", now).state).toBe("undated");
    const high = { ...base, importance: "high" as const, cadenceDays: 5, earliest: "2026-11-01", latest: "2026-11-08", lastNudgedAt: now - DAY };
    expect(taskTiming(high, "2026-11-06", now)).toMatchObject({ dueForNudge: true, reason: "high importance and closing soon" });
  });

  it("uses tighter default cadences for dated and high-importance tasks", () => {
    expect(defaultCadence("normal", false)).toBe(3);
    expect(defaultCadence("high", false)).toBe(2);
    expect(defaultCadence("normal", true)).toBe(2);
    expect(defaultCadence("high", true)).toBe(1);
  });
});
