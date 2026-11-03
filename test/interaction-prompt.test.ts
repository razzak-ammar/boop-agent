import { describe, it, expect } from "vitest";
import { buildInteractionPrompt } from "../server/interaction-prompt.js";
describe("trusted time context", () => {
  it("includes only an explicit saved user timezone", () => {
    const prompt = buildInteractionPrompt(["gmail"], {isExplicit:true,timezone:"America/New_York",now:"Oct 31, 2026, 6:00 PM"});
    expect(prompt).toContain('"userTimezone":"America/New_York"');
    expect(prompt).toContain('"currentLocalTime":"Oct 31, 2026, 6:00 PM"');
    expect(prompt).toContain('Available integrations: gmail');
  });
  it("anchors clock-only reminders to the application date rather than UTC", () => {
    const prompt = buildInteractionPrompt([], {isExplicit:true,timezone:"America/New_York",now:"Sun, Nov 1, 2026, 7:49 PM EST",isoDate:"2026-11-01"});
    expect(prompt).toContain('"currentLocalDate":"2026-11-01"');
    expect(prompt).toContain('day="today"');
    expect(prompt).toContain("Echo the saved weekday, calendar date, time, and timezone");
  });
  it("reads bare clock times as upcoming and resolves them before delegating", () => {
    const prompt = buildInteractionPrompt([], {isExplicit:true,timezone:"America/New_York",now:"Mon, Nov 2, 2026, 6:45 PM EST",isoDate:"2026-11-02"});
    expect(prompt).toContain('at 6:45 PM, "8-9:30" with no day means 8:00-9:30 PM today');
    expect(prompt).toContain("write the resolved local date and 24-hour times into the task");
  });
  it("does not expose the server fallback as the user's clock", () => {
    const prompt = buildInteractionPrompt([], {isExplicit:false,timezone:"UTC",now:"server-clock"});
    expect(prompt).toContain('"userTimezone":null,"currentLocalTime":null');
    expect(prompt).not.toContain('server-clock');
  });
});

describe("connected capability guidance", () => {
  it("omits Mac-specific instructions on a server with no Apple connection", () => {
    const prompt = buildInteractionPrompt([], {isExplicit:false, timezone:"UTC", now:"ignored"});
    expect(prompt).not.toContain("read-only Mac data");
    expect(prompt).not.toContain("{{");
  });
  it("retains instructions when optional integrations are actually present", () => {
    const prompt = buildInteractionPrompt(["apple", "browser"], {isExplicit:false, timezone:"UTC", now:"ignored"});
    expect(prompt).toContain("read-only Mac data");
    expect(prompt).toContain("Relay login handoffs");
  });
});
