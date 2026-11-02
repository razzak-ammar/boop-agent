import { describe, it, expect, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { reviseTimeTrackerDraft } from "../server/time-tracker/tools.js";
import { buildInteractionPrompt } from "../server/interaction-prompt.js";

describe("TimeTracker follow-ups", () => {
  it("changes only the note of a pending entry, retaining its original date, project and retry ID", async () => {
    const body = { id: "stable", projectId: "vibrant", startTime: "2026-10-30T12:00:00-04:00", endTime: "2026-10-30T12:30:00-04:00", description: "KICKR meeting" };
    const result = await reviseTimeTrackerDraft(JSON.stringify({ operation: "create_event", body }), { description: "Attended meeting with KICKR to go over the estimate" }, undefined, async () => "America/New_York");
    expect(JSON.parse(result.payload).body).toEqual({ ...body, description: "Attended meeting with KICKR to go over the estimate" });
    expect(result.summary).toContain("Friday, Oct 30");
    expect(result.summary).toContain("12:00 PM EDT");
  });
  it("rejects ownership or ID changes in a follow-up", async () => {
    await expect(reviseTimeTrackerDraft(JSON.stringify({ operation: "create_project", body: { id: "stable", name: "Research", color: "#123456" } }), { id: "different" })).rejects.toThrow();
  });
  it("instructs the main agent to finish routine requests without a worker or approval loop", () => {
    const prompt = buildInteractionPrompt(["timetracker"], { isExplicit: true, timezone: "America/New_York", now: "Sunday, Nov 1, 2026", isoDate: "2026-11-01" });
    expect(prompt).toContain("Do not delegate routine time tracking");
    expect(prompt).toContain("Finish all requested items");
    expect(prompt).toContain("never ask the user to resend");
    expect(prompt).toContain("recall relevant project associations");
    expect(prompt).toContain("SAME turn");
  });
});
