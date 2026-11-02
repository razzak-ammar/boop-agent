import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({convex:{query:vi.fn().mockResolvedValue([]),mutation:vi.fn().mockResolvedValue(null)}}));
vi.mock("../server/runtime-config.js", async original => ({...await original<typeof import("../server/runtime-config.js")>(),getRuntimeConfig:vi.fn().mockResolvedValue({runtime:"codex",model:"gpt-6-luna",reasoningEffort:"low",billingMode:"codex-subscription"})}));
vi.mock("../server/integrations/registry.js", async original => ({...await original<typeof import("../server/integrations/registry.js")>(),listEnabledIntegrations:vi.fn().mockResolvedValue([])}));
vi.mock("../server/timezone-config.js", async original => ({...await original<typeof import("../server/timezone-config.js")>(),describeUserNow:vi.fn().mockResolvedValue({isExplicit:true,timezone:"America/New_York",now:"Sun, Nov 1, 2026, 7:49 PM EST",isoDate:"2026-11-01"})}));
vi.mock("../server/memory/extract.js", () => ({extractAndStore:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../server/runtimes/index.js", () => ({runAgentRuntime:vi.fn()}));
import { handleUserMessage } from "../server/interaction-agent.js";
import { runAgentRuntime } from "../server/runtimes/index.js";
import { convex } from "../server/convex-client.js";
import { getFunctionName } from "convex/server";
import { EMPTY_USAGE } from "../server/usage.js";
beforeEach(() => {vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-02T00:49:59Z"));});
afterEach(() => vi.useRealTimers());
describe("clock-only reminder intake", () => {
  it("replaces contradictory model prose with the actual saved reminder receipt", async () => {
    vi.mocked(runAgentRuntime).mockImplementation(async (_config, request) => {
      const reminder = request.tools.find(tool => tool.name === "create_reminder")!;
      await reminder.handle({message:"Check the NIRVE data",localTime:"20:30",day:"today"});
      return {text:"You missed 8:30 PM today, so I didn't move it to another day. What date should I set it for?",usage:{...EMPTY_USAGE}};
    });
    const reply = await handleUserMessage({conversationId:"fixture",content:"Remind me at 8:30 pm to check the NIRVE data"});
    expect(reply).toContain("Sun, Nov 1, 2026, 8:30 PM EST");
    expect(reply).not.toContain("missed");
    expect(reply).not.toContain("What date");
  });
  it("keeps unrelated work results when scheduling is part of a larger request", async () => {
    vi.mocked(runAgentRuntime).mockImplementation(async (_config, request) => {
      await request.onToolUse?.("mcp__boop-spawn__boop_delegate_task", {task:"Check the project"});
      await request.tools.find(tool => tool.name === "create_reminder")!.handle({message:"Check the NIRVE data",localTime:"20:30",day:"today"});
      return {text:"The project check is complete.",usage:{...EMPTY_USAGE}};
    });
    const reply = await handleUserMessage({conversationId:"fixture",content:"Check the project and remind me at 8:30 pm"});
    expect(reply).toContain("Sun, Nov 1, 2026, 8:30 PM EST");
    expect(reply).toContain("The project check is complete.");
  });
  it("blocks a wrong-day absolute time through the actual dispatcher tools", async () => {
    vi.mocked(runAgentRuntime).mockImplementation(async (_config, request) => {
      const result = await request.tools.find(tool => tool.name === "create_reminder")!.handle({message:"Check the NIRVE data",at:"2026-11-02T20:30:00"});
      expect(result.success).toBe(false);
      expect(result.text).toContain("conflicts");
      return {text:"The date needs correction.",usage:{...EMPTY_USAGE}};
    });
    await handleUserMessage({conversationId:"fixture",content:"Remind me at 8:30 pm to check the NIRVE data"});
    expect(vi.mocked(convex.mutation).mock.calls.some(([ref]) => getFunctionName(ref) === "automations:create")).toBe(false);
  });
});
