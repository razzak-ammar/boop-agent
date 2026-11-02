import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("../server/convex-client.js", () => ({
  convex: { query: vi.fn(), mutation: vi.fn() },
}));
vi.mock("../server/execution-agent.js", () => ({
  spawnExecutionAgent: vi.fn(),
}));
vi.mock("../server/notifications.js", () => ({
  sendConversationNotification: vi.fn(),
}));
vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/timezone-config.js", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/New_York"),
}));
import { convex } from "../server/convex-client.js";
import { spawnExecutionAgent } from "../server/execution-agent.js";
import { sendConversationNotification } from "../server/notifications.js";
import { tickAutomations } from "../server/automations.js";
const reminder = {
  automationId: "auto_test",
  name: "Take laundry out",
  task: "Take laundry out",
  integrations: [],
  schedule: "once",
  scheduleKind: "once",
  delivery: "reminder",
  reminderText: "Take laundry out",
  notifyConversationId: "telegram:fixture",
  timezone: "America/New_York",
  nextRunAt: 1,
};
let claimed = false;
beforeEach(() => {
  vi.clearAllMocks();
  claimed = false;
  vi.mocked(convex.query).mockResolvedValue([reminder]);
  vi.mocked(convex.mutation).mockImplementation(async (ref) => {
    const name = getFunctionName(ref);
    if (name === "automations:claimRun") {
      if (claimed) return null;
      claimed = true;
      return reminder;
    }
    if (name === "automations:renewClaim") return true;
    return null;
  });
  vi.mocked(sendConversationNotification).mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
describe("reminder execution", () => {
  it("delivers saved reminder text once across overlapping ticks with zero model calls", async () => {
    await Promise.all([tickAutomations(), tickAutomations()]);
    expect(sendConversationNotification).toHaveBeenCalledExactlyOnceWith(
      "telegram:fixture",
      "Reminder: Take laundry out",
    );
    expect(spawnExecutionAgent).not.toHaveBeenCalled();
    const finish = vi
      .mocked(convex.mutation)
      .mock.calls.find(
        ([ref]) => getFunctionName(ref) === "automations:finishRun",
      );
    expect(finish?.[1]).toMatchObject({ success: true });
  });
  it("records failed delivery for durable retry instead of successful completion", async () => {
    vi.mocked(sendConversationNotification).mockRejectedValueOnce(
      new Error("Telegram unavailable"),
    );
    await tickAutomations();
    const finish = vi
      .mocked(convex.mutation)
      .mock.calls.find(
        ([ref]) => getFunctionName(ref) === "automations:finishRun",
      );
    expect(finish?.[1]).toMatchObject({
      success: false,
      error: expect.stringContaining("Telegram unavailable"),
    });
  });
  it("does not deliver after pause or lease loss", async () => {
    vi.mocked(convex.mutation).mockImplementation(async (ref) =>
      getFunctionName(ref) === "automations:claimRun"
        ? reminder
        : getFunctionName(ref) === "automations:renewClaim"
          ? false
          : null,
    );
    await tickAutomations();
    expect(sendConversationNotification).not.toHaveBeenCalled();
  });
});

it("keeps legacy cron tasks on the model-backed execution path", async () => {
  const legacy = {
    ...reminder,
    delivery: undefined,
    scheduleKind: undefined,
    schedule: "0 9 * * 1-5",
    reminderText: undefined,
    conversationId: "telegram:fixture",
  };
  vi.mocked(convex.mutation).mockImplementation(async (ref) =>
    getFunctionName(ref) === "automations:claimRun"
      ? legacy
      : getFunctionName(ref) === "automations:renewClaim"
        ? true
        : null,
  );
  vi.mocked(spawnExecutionAgent).mockResolvedValueOnce({
    agentId: "agent_fixture",
    status: "completed",
    result: "Your calendar is clear.",
  });
  await tickAutomations();
  expect(spawnExecutionAgent).toHaveBeenCalled();
  const finish = vi
    .mocked(convex.mutation)
    .mock.calls.find(
      ([ref]) => getFunctionName(ref) === "automations:finishRun",
    );
  expect(finish?.[1]).toMatchObject({
    success: true,
    agentId: "agent_fixture",
    nextRunAt: expect.any(Number),
  });
});
