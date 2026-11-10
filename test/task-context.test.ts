import { describe, expect, it, vi } from "vitest";

vi.mock("../server/convex-client.js", () => ({ convex: {} }));

import { formatTasksNote } from "../server/tasks/context.js";

const opts = { today: "2026-11-09", clock: "18:00", timezone: "America/New_York", now: Date.parse("2026-11-09T23:00:00Z") };
const task = {
  taskId: "task_poster",
  title: "Poster edits for the research conference",
  notes: "Send to advisor for review",
  latest: "2026-11-13",
  importance: "high" as const,
  cadenceDays: 1,
  createdAt: 0,
  nudgeCount: 0,
};

describe("tracked items prompt note", () => {
  it("adds nothing when nothing is tracked", () => {
    expect(formatTasksNote([], [], opts)).toBe("");
  });

  it("lists open tasks with their dates and timing state", () => {
    const note = formatTasksNote([task], [], opts);
    expect(note).toContain("Match what they say against these");
    const row = JSON.parse(note.split("\n").find((l) => l.startsWith("{"))!);
    expect(row).toMatchObject({ taskId: "task_poster", latest: "2026-11-13", importance: "high", state: "in_window" });
  });

  it("lists reminders and check-ins due in the next week only", () => {
    const soon = { automationId: "auto_a", name: "Exam prep", delivery: "reminder", reminderText: "How is exam prep going?", nextRunAt: opts.now + 3600000 };
    const later = { ...soon, automationId: "auto_b", nextRunAt: opts.now + 30 * 86400000 };
    const checkin = { automationId: "auto_c", name: "Check-in: Exam review", delivery: "checkin", goalId: "goal_x", nextRunAt: opts.now + 7200000 };
    const note = formatTasksNote([], [later, checkin, soon], opts);
    expect(note).toContain("How is exam prep going?");
    expect(note).toContain("goal check-in");
    expect(note).not.toContain("auto_b");
    expect(note.indexOf("auto_a")).toBeLessThan(note.indexOf("auto_c"));
  });

  it("keeps one-off reminders that fired this week, since the work may be unfinished", () => {
    const fired = { automationId: "auto_f", name: "Send poster", delivery: "reminder", reminderText: "Send your poster to your advisor", enabled: false, lastRunAt: opts.now - 8 * 3600000 };
    const old = { ...fired, automationId: "auto_old", reminderText: "Old thing", lastRunAt: opts.now - 9 * 86400000 };
    const note = formatTasksNote([], [fired, old], opts);
    expect(note).toContain("Reminders already sent in the last 7 days");
    expect(note).toContain("Send your poster to your advisor");
    expect(note).not.toContain("Old thing");
    expect(note).not.toContain("Scheduled reminders");
  });
});
