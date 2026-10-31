import { describe, it, expect } from "vitest";
import { shouldExtractMemory } from "../server/memory/extraction-policy.js";
describe("conservative memory extraction gate", () => {
  it.each(["Hi!", "thanks", "Thank you!!", "ok.", "got it", "sounds good"]) ("skips social filler: %s", text => {
    expect(shouldExtractMemory(text)).toBe(false);
  });
  it.each([
    "Hi, I'm Sam and I study biology.", "Thanks, I prefer short replies.",
    "Actually, my name is Sara, not Sarah.", "I no longer work at Acme.",
    "Remember I use Google Calendar.", "My project is called Okay.",
    "I'm tired today", "", "sí", "Remind me every day at 9am",
  ])("keeps the extractor for substantive or ambiguous text: %s", text => {
    expect(shouldExtractMemory(text)).toBe(true);
  });
  it("keeps extraction for captionless and greeting-captioned images", () => {
    expect(shouldExtractMemory("", ["image"])).toBe(true);
    expect(shouldExtractMemory("hi", ["image"])).toBe(true);
  });
});
