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
vi.mock("../server/goals/checkin.js", () => ({ runGoalCheckin: vi.fn() }));
vi.mock("../server/tasks/lookahead.js", () => ({ runLookahead: vi.fn(), recordLookaheadDelivered: vi.fn() }));
vi.mock("../server/freetime/checkin.js", () => ({ runFreeTimeCheck: vi.fn() }));
vi.mock("../server/timezone-config.js", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/New_York"),
}));
import { convex } from "../server/convex-client.js";
import { spawnExecutionAgent } from "../server/execution-agent.js";
import { sendConversationNotification } from "../server/notifications.js";
import { tickAutomations } from "../server/automations.js";
import { runGoalCheckin } from "../server/goals/checkin.js";
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

describe("goal check-ins", () => {
  const checkin = {
    ...reminder,
    automationId: "auto_checkin",
    name: "Check-in: Exam review",
    delivery: "checkin",
    reminderText: undefined,
    goalId: "goal_fixture",
  };
  function claimCheckin() {
    vi.mocked(convex.query).mockResolvedValue([checkin]);
    vi.mocked(convex.mutation).mockImplementation(async (ref) =>
      getFunctionName(ref) === "automations:claimRun"
        ? checkin
        : getFunctionName(ref) === "automations:renewClaim"
          ? true
          : null,
    );
  }
  const calls = (name: string) =>
    vi.mocked(convex.mutation).mock.calls.filter(([ref]) => getFunctionName(ref) === name);

  it("sends the model-written message as is", async () => {
    claimCheckin();
    vi.mocked(runGoalCheckin).mockResolvedValueOnce({ text: "You're at 6/12 — 3 to go before Saturday. How many today?" });
    await tickAutomations();
    expect(runGoalCheckin).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_fixture" }));
    expect(sendConversationNotification).toHaveBeenCalledExactlyOnceWith(
      "telegram:fixture",
      "You're at 6/12 — 3 to go before Saturday. How many today?",
    );
    expect(spawnExecutionAgent).not.toHaveBeenCalled();
  });

  it("stays quiet when the model decides nothing is worth sending", async () => {
    claimCheckin();
    vi.mocked(runGoalCheckin).mockResolvedValueOnce({});
    await tickAutomations();
    expect(sendConversationNotification).not.toHaveBeenCalled();
    expect(calls("automations:finishRun")[0]?.[1]).toMatchObject({ success: true });
  });

  it("disables the check-in once its goal is finished or dropped", async () => {
    claimCheckin();
    vi.mocked(runGoalCheckin).mockResolvedValueOnce({ inactive: true });
    await tickAutomations();
    expect(sendConversationNotification).not.toHaveBeenCalled();
    expect(calls("automations:setEnabled")[0]?.[1]).toEqual({ automationId: "auto_checkin", enabled: false });
  });
});

describe("same-moment delivery to one chat", () => {
  const checkin = {
    ...reminder,
    automationId: "auto_checkin",
    name: "Check-in: Exam review",
    delivery: "checkin",
    reminderText: undefined,
    goalId: "goal_fixture",
  };
  const prep = { ...reminder, automationId: "auto_prep", reminderText: "How is exam prep going?" };
  function dueTogether() {
    const rows = new Map([checkin, prep].map((a) => [a.automationId, a]));
    const claimedIds = new Set<string>();
    vi.mocked(convex.query).mockResolvedValue([prep, checkin]);
    vi.mocked(convex.mutation).mockImplementation(async (ref, args: any) => {
      const name = getFunctionName(ref);
      if (name === "automations:claimRun") {
        if (claimedIds.has(args.automationId)) return null;
        claimedIds.add(args.automationId);
        return rows.get(args.automationId);
      }
      if (name === "automations:renewClaim") return true;
      return null;
    });
  }
  const finishes = () =>
    vi.mocked(convex.mutation).mock.calls
      .filter(([ref]) => getFunctionName(ref) === "automations:finishRun")
      .map(([, args]) => args as any);

  it("folds a reminder into a check-in sent at the same time", async () => {
    dueTogether();
    vi.mocked(runGoalCheckin).mockResolvedValueOnce({ text: "Exam Thursday: 0/8 lectures so far. How many can you do tonight?" });
    await tickAutomations();
    expect(runGoalCheckin).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_fixture" }), ["How is exam prep going?"]);
    expect(sendConversationNotification).toHaveBeenCalledExactlyOnceWith(
      "telegram:fixture",
      "Exam Thursday: 0/8 lectures so far. How many can you do tonight?",
    );
    expect(finishes()).toHaveLength(2);
    expect(finishes().every((f) => f.success)).toBe(true);
  });

  it("still sends the reminder when the check-in has nothing to say", async () => {
    dueTogether();
    vi.mocked(runGoalCheckin).mockResolvedValueOnce({});
    await tickAutomations();
    expect(sendConversationNotification).toHaveBeenCalledExactlyOnceWith(
      "telegram:fixture",
      "Reminder: How is exam prep going?",
    );
  });

  it("claims the reminder before the slow check-in so a second tick can't send it", async () => {
    dueTogether();
    let release!: () => void;
    vi.mocked(runGoalCheckin).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ text: "Combined" }); }),
    );
    const first = tickAutomations();
    await new Promise((r) => setTimeout(r, 0));
    await tickAutomations();
    release();
    await first;
    expect(sendConversationNotification).toHaveBeenCalledExactlyOnceWith("telegram:fixture", "Combined");
  });
});
