import { describe, expect, it } from "vitest";
import { defaultCadenceHours, inQuietHours, taskTiming } from "../server/tasks/timing.js";

const MIN = 60000;
const now = Date.parse("2026-11-06T20:00:00Z");
const today = "2026-11-06";
const hourly = { importance: "normal" as const, cadenceDays: 1, cadenceHours: 1, nudgeCount: 0, createdAt: now - 5 * 60 * MIN };

describe("hourly task check-ins", () => {
  it("nudges every hour until done, with a little slack for the 15-minute pulse", () => {
    expect(taskTiming({ ...hourly, lastNudgedAt: now - 30 * MIN }, today, now, "15:00").dueForNudge).toBe(false);
    expect(taskTiming({ ...hourly, lastNudgedAt: now - 52 * MIN }, today, now, "15:00")).toMatchObject({ state: "undated", dueForNudge: true });
  });

  it("waits a full hour after creation before the first nudge", () => {
    expect(taskTiming({ ...hourly, createdAt: now - 20 * MIN }, today, now, "15:00").dueForNudge).toBe(false);
  });

  it("stays quiet overnight", () => {
    expect(inQuietHours("23:30")).toBe(true);
    expect(inQuietHours("07:59")).toBe(true);
    expect(inQuietHours("08:00")).toBe(false);
    expect(taskTiming({ ...hourly, lastNudgedAt: now - 3 * 60 * MIN }, today, now, "23:00").dueForNudge).toBe(false);
  });

  it("counts down to a same-day deadline and gives a last call", () => {
    const task = { ...hourly, cadenceHours: 2, latest: today, dueTime: "20:00" };
    expect(taskTiming({ ...task, lastNudgedAt: now - 60 * MIN }, today, now, "17:00")).toMatchObject({ state: "last_day", minutesLeft: 180, dueForNudge: false });
    expect(taskTiming({ ...task, lastNudgedAt: now - 40 * MIN }, today, now, "19:15")).toMatchObject({ minutesLeft: 45, dueForNudge: true, reason: "deadline within the hour" });
    expect(taskTiming({ ...task, lastNudgedAt: now - 10 * MIN }, today, now, "19:15").dueForNudge).toBe(false);
  });

  it("a deadline inside quiet hours still gets its last call", () => {
    const task = { ...hourly, latest: today, dueTime: "23:00", lastNudgedAt: now - 45 * MIN };
    expect(taskTiming(task, today, now, "22:30")).toMatchObject({ dueForNudge: true, reason: "deadline within the hour" });
  });

  it("asks once right after the deadline passes, then stops for the day", () => {
    const task = { ...hourly, latest: today, dueTime: "20:00" };
    expect(taskTiming({ ...task, lastNudgedAt: now - 40 * MIN }, today, now, "20:15")).toMatchObject({ state: "overdue", minutesLeft: -15, dueForNudge: true, reason: "deadline just passed" });
    expect(taskTiming({ ...task, lastNudgedAt: now - 5 * MIN }, today, now, "20:15").dueForNudge).toBe(false);
    expect(taskTiming({ ...task, lastNudgedAt: now - 2 * 60 * MIN }, today, now, "21:30").dueForNudge).toBe(false);
  });

  it("goes back to one daily nudge on later days", () => {
    const task = { ...hourly, createdAt: now - 48 * 60 * MIN, latest: "2026-11-05", dueTime: "20:00", lastNudgedAt: now - 20 * 60 * MIN };
    expect(taskTiming(task, today, now, "15:00")).toMatchObject({ state: "overdue", daysOverdue: 1, dueForNudge: true });
    expect(taskTiming({ ...task, lastNudgedAt: now - 2 * 60 * MIN }, today, now, "15:00").dueForNudge).toBe(false);
    expect(taskTiming(task, today, now, "06:00").dueForNudge).toBe(false);
  });

  it("defaults to tighter cadences when there's a deadline", () => {
    expect(defaultCadenceHours("high", true)).toBe(1);
    expect(defaultCadenceHours("normal", true)).toBe(2);
    expect(defaultCadenceHours("normal", false)).toBe(3);
  });
});
