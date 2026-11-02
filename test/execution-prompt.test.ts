import { describe, expect, it } from "vitest";
import { buildExecutionPrompt } from "../server/execution-agent.js";
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
