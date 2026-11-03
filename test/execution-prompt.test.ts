import { describe, expect, it } from "vitest";
import { buildExecutionPrompt, taskWithUserRequest } from "../server/execution-agent.js";
describe("worker time handling", () => {
  it("reads bare clock times as their next upcoming occurrence", () => {
    const prompt = buildExecutionPrompt([], { isExplicit: true, timezone: "America/New_York", now: "Mon, Nov 2, 2026, 6:45 PM EST", isoDate: "2026-11-02" });
    expect(prompt).toContain("next upcoming occurrence after currentLocalTime");
    expect(prompt).toContain("never borrow a date from a different earlier item");
  });
  it("attaches the user's exact message to a delegated task once", () => {
    const message = "Add to time blocks 8-9:30 study session";
    const task = taskWithUserRequest("Create a Time Blocks event 2026-11-02 08:00-09:30", message);
    expect(task).toContain(`"""\n${message}\n"""`);
    expect(taskWithUserRequest(`Do this: ${message}`, message)).toBe(`Do this: ${message}`);
    expect(taskWithUserRequest("Look up news", "  ")).toBe("Look up news");
    expect(taskWithUserRequest("t", "x".repeat(3000))).toContain(`${"x".repeat(2000)}…`);
  });
});
describe("worker capability context", () => {
  it("retains source and draft policies without unconnected laptop guidance", () => {
    const prompt = buildExecutionPrompt([]);
    expect(prompt).not.toContain("Apple data:");
    expect(prompt).not.toContain("Local browser:");
    expect(prompt).toContain("ACTUAL URLs");
    expect(prompt).toContain("Use save_draft only for an explicit draft request");
    expect(prompt).toContain("Do not add an approval step");
  });
  it("keeps optional integration guidance when available", () => {
    expect(buildExecutionPrompt(["apple", "browser"])).toContain("Apple data:");
    expect(buildExecutionPrompt(["apple", "browser"])).toContain("Local browser:");
  });
  it("requires calendar searches to use compact sorted results and honest coverage", () => {
    const prompt = buildExecutionPrompt(["googlecalendar"]);
    expect(prompt).toContain("Use search_calendar_events");
    expect(prompt).toContain('terms=["midterm","quiz"]');
    expect(prompt).toContain("complete=false");
    expect(buildExecutionPrompt([])).not.toContain("Calendar reads:");
  });
});
