import { describe, expect, it } from "vitest";
import { computePacing, daysBetween, defaultCheckinDays } from "../server/goals/pacing.js";

const exam = {
  title: "Exam review",
  deadline: "2026-11-12",
  unit: "lectures",
  total: 12,
  progress: 0,
  milestones: [
    { date: "2026-11-07", label: "75% reviewed", target: 9 },
    { date: "2026-11-09", label: "100% reviewed", target: 12 },
  ],
};

describe("goal pacing", () => {
  it("counts whole local days across a DST change", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("spreads the next milestone's remaining units over the days left, including today", () => {
    const p = computePacing({ ...exam, progress: 3 }, "2026-11-04");
    expect(p.next).toMatchObject({ date: "2026-11-07", remaining: 6, workDays: 4, perDay: 1.5 });
    expect(p.status).toBe("on_track");
    expect(p.percent).toBe(25);
  });

  it("flags a passed milestone that wasn't reached", () => {
    const p = computePacing({ ...exam, progress: 6 }, "2026-11-08");
    expect(p.status).toBe("behind");
    expect(p.missed.map((m) => m.date)).toEqual(["2026-11-07"]);
    expect(p.next).toMatchObject({ date: "2026-11-09", remaining: 6, perDay: 3 });
  });

  it("reports done once the total is reached", () => {
    expect(computePacing({ ...exam, progress: 12 }, "2026-11-08").status).toBe("done");
  });

  it("checks in the evening before each milestone and the deadline, skipping past days", () => {
    expect(defaultCheckinDays(exam, "2026-11-07")).toEqual(["2026-11-08", "2026-11-11"]);
    expect(defaultCheckinDays(exam, "2026-11-03")).toEqual(["2026-11-06", "2026-11-08", "2026-11-11"]);
  });
});
