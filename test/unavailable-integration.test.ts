import { describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { mutation: vi.fn(), query: vi.fn() } }));
vi.mock("../server/runtimes/index.js", () => ({ runAgentRuntime: vi.fn() }));
import { convex } from "../server/convex-client.js";
import { runAgentRuntime } from "../server/runtimes/index.js";
import { spawnExecutionAgent } from "../server/execution-agent.js";
import { unavailableSpawnIntegrations } from "../server/interaction-agent.js";
describe("unavailable integrations", () => {
  it("preserves missing capability instead of silently stripping it", () => {
    expect(unavailableSpawnIntegrations(["apple", "gmail", "apple"], ["gmail"])).toEqual(["apple"]);
    expect(unavailableSpawnIntegrations([], [])).toEqual([]);
  });
  it("fails before model usage or worker creation", async () => {
    const result = await spawnExecutionAgent({ task: "Read my calendar", integrations: ["not-connected"] });
    expect(result.status).toBe("failed");
    expect(result.result).toContain("not-connected");
    expect(runAgentRuntime).not.toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});
