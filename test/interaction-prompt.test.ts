import { describe, it, expect } from "vitest";
import { buildInteractionPrompt } from "../server/interaction-prompt.js";
describe("trusted time context", () => {
  it("includes only an explicit saved user timezone", () => {
    const prompt = buildInteractionPrompt(["gmail"], {isExplicit:true,timezone:"America/New_York",now:"Oct 31, 2026, 6:00 PM"});
    expect(prompt).toContain('"userTimezone":"America/New_York"');
    expect(prompt).toContain('"currentLocalTime":"Oct 31, 2026, 6:00 PM"');
    expect(prompt).toContain('Available integrations: gmail');
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
