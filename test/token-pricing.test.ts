import { describe, expect, it } from "vitest";
import { costForRecord, estimateOpenAiCostUsd, formatRecordCost } from "../server/token-pricing.js";
const calendar = { model: "gpt-6-luna", inputTokens: 26048, outputTokens: 71, cacheReadTokens: 12800, cacheCreationTokens: 0 };
describe("token pricing", () => {
  it("prices original calendar usage with cached input as a subset", () => {
    expect(estimateOpenAiCostUsd(calendar)).toBeCloseTo(0.0014883, 10);
  });
  it.each([
    ["gpt-6-luna", 0.1], ["gpt-6.1-sol", 2], ["gpt-6.1-terra", 1], ["gpt-6-astra", 10],
  ])("prices Standard %s input", (model, price) => {
    expect(estimateOpenAiCostUsd({ ...calendar, model, inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 })).toBe(price);
  });
  it("supports dated snapshots without guessing future variants", () => {
    expect(estimateOpenAiCostUsd({ ...calendar, model: "gpt-6-luna-2026-10-01" })).not.toBeNull();
    expect(estimateOpenAiCostUsd({ ...calendar, model: "gpt-6-luna-new" })).toBeNull();
    expect(estimateOpenAiCostUsd({ ...calendar, model: "gpt-5.99" })).toBeNull();
  });
  it("clamps cached input to the input count", () => {
    expect(estimateOpenAiCostUsd({ ...calendar, inputTokens: 100, cacheReadTokens: 10000, outputTokens: 0 })).toBeCloseTo(0.000001, 10);
  });
  it("repairs old zero-cost Codex rows on read and labels them honestly", () => {
    const record = { ...calendar, costUsd: 0, runtime: "codex", billingMode: "codex-subscription" };
    expect(costForRecord(record)).toBeCloseTo(0.0014883, 10);
    expect(formatRecordCost(record)).toBe("~$0.0015 API equivalent");
    expect(formatRecordCost({ ...record, model: "unknown" })).toBe("Cost unavailable");
    expect(costForRecord({ ...record, runtime: "claude", billingMode: "api", costUsd: 1.23 })).toBe(1.23);
  });
});
