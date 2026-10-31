import { describe, expect, it } from "vitest";
import { buildExecutionPrompt } from "../server/execution-agent.js";
describe("worker capability context", () => {
  it("retains source and draft policies without unconnected laptop guidance", () => {
    const prompt = buildExecutionPrompt([]);
    expect(prompt).not.toContain("Apple data:");
    expect(prompt).not.toContain("Local browser:");
    expect(prompt).toContain("ACTUAL URLs");
    expect(prompt).toContain("call save_draft");
    expect(prompt).toContain("You never commit");
  });
  it("keeps optional integration guidance when available", () => {
    expect(buildExecutionPrompt(["apple", "browser"])).toContain("Apple data:");
    expect(buildExecutionPrompt(["apple", "browser"])).toContain("Local browser:");
  });
});
