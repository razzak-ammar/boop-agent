import { beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({
  convex: { query: vi.fn(), mutation: vi.fn() },
}));
vi.mock("../server/timezone-config.js", () => ({ describeUserNow: vi.fn() }));
import { convex } from "../server/convex-client.js";
import { describeUserNow } from "../server/timezone-config.js";
import { createAutomationTools } from "../server/automation-tools.js";
beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.mocked(describeUserNow).mockResolvedValue({
    isExplicit: false,
    timezone: "UTC",
    now: "now",
    isoDate: "2026-10-31",
    weekday: "Sat",
    hourMinute: "12:00",
  });
});
describe("reminder tool contracts", () => {
  it("saves the real clock-only request for tonight and rejects a model-supplied tomorrow date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T00:49:59Z"));
    vi.mocked(describeUserNow).mockResolvedValue({isExplicit:true,timezone:"America/New_York",now:"Sunday Nov 1, 2026, 7:49 PM EST",isoDate:"2026-11-01",weekday:"Sunday",hourMinute:"7:49 PM"});
    const receipt = vi.fn();
    const tool = createAutomationTools("telegram:fixture", "Remind me at 8:30 pm to check the NIRVE data", receipt).find(t => t.name === "create_reminder")!;
    const wrong = await tool.handle({ message: "Check the NIRVE data", at: "2026-11-02T20:30:00" });
    expect(wrong.success).toBe(false);
    expect(wrong.text).toContain("conflicts");
    expect(convex.mutation).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    const right = await tool.handle({ message: "Check the NIRVE data", localTime: "20:30", day: "today" });
    expect(right.success).not.toBe(false);
    expect(right.text).toContain("Sunday, November 1, 2026");
    expect(receipt).toHaveBeenCalledWith(expect.stringContaining("Sun, Nov 1, 2026, 8:30 PM EST"));
    expect(convex.mutation).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({nextRunAt:Date.parse("2026-11-02T01:30:00Z")}));
    vi.useRealTimers();
  });
  it("creates a relative one-time reminder with saved literal text", async () => {
    const tool = createAutomationTools("telegram:fixture").find(
      (t) => t.name === "create_reminder",
    )!;
    const result = await tool.handle({
      message: "Take the laundry out",
      afterSeconds: 1800,
    });
    expect(result.success).not.toBe(false);
    expect(convex.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        delivery: "reminder",
        scheduleKind: "once",
        reminderText: "Take the laundry out",
        notifyConversationId: "telegram:fixture",
        integrations: [],
      }),
    );
  });
  it("refuses to substitute the server zone for a missing user timezone", async () => {
    const tool = createAutomationTools("telegram:fixture").find(
      (t) => t.name === "create_reminder",
    )!;
    const result = await tool.handle({
      message: "Stretch",
      schedule: "0 9 * * 1,3,5",
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("timezone");
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});
