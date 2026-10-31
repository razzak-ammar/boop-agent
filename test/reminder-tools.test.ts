import { beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({
  convex: { query: vi.fn(), mutation: vi.fn() },
}));
vi.mock("../server/timezone-config.js", () => ({ describeUserNow: vi.fn() }));
import { convex } from "../server/convex-client.js";
import { describeUserNow } from "../server/timezone-config.js";
import { createAutomationTools } from "../server/automation-tools.js";
beforeEach(() => {
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
