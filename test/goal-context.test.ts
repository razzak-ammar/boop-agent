import { describe, expect, it, vi } from "vitest";

vi.mock("../server/convex-client.js", () => ({ convex: {} }));

import { formatGoalsNote } from "../server/goals/context.js";

const goal = {
  goalId: "goal_a",
  title: "Exam review",
  deadline: "2026-11-12",
  unit: "lectures",
  total: 12,
  progress: 6,
  milestones: [{ date: "2026-11-09", label: "75%", target: 9 }],
};

describe("active goals prompt note", () => {
  it("adds nothing when there are no active goals", () => {
    expect(formatGoalsNote([], "2026-11-08")).toBe("");
  });

  it("includes the goal id and computed pacing", () => {
    const note = formatGoalsNote([goal], "2026-11-08");
    const row = JSON.parse(note.trim().split("\n").at(-1)!);
    expect(row).toMatchObject({
      goalId: "goal_a",
      daysToDeadline: 4,
      percent: 50,
      status: "on_track",
      next: { label: "75%", remaining: 3, perDay: 1.5 },
    });
  });

  it("keeps the soonest deadlines and says how many were left out", () => {
    const goals = Array.from({ length: 22 }, (_, i) => ({
      ...goal,
      milestones: [],
      goalId: `goal_${i}`,
      deadline: `2026-12-${String(22 - i).padStart(2, "0")}`,
    }));
    const note = formatGoalsNote(goals, "2026-11-08");
    expect(note).toContain("the 2 not shown here");
    expect(note).toContain('"goalId":"goal_21"');
    expect(note).not.toContain('"goalId":"goal_0"');
  });
});
