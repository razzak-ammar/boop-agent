import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({convex:{query:vi.fn().mockResolvedValue([]),mutation:vi.fn().mockResolvedValue(null)}}));
vi.mock("../server/embeddings.js", () => ({embed:vi.fn().mockResolvedValue(null),embeddingsAvailable:()=>false}));
vi.mock("../server/broadcast.js", () => ({broadcast:vi.fn()}));
vi.mock("../server/runtime-config.js", async importOriginal => ({...await importOriginal<typeof import("../server/runtime-config.js")>(),getRuntimeConfig:vi.fn().mockResolvedValue({runtime:"codex",model:"gpt-6-luna",reasoningEffort:"low",billingMode:"codex-subscription"})}));
vi.mock("../server/integrations/registry.js", async importOriginal => ({...await importOriginal<typeof import("../server/integrations/registry.js")>(),listEnabledIntegrations:vi.fn().mockResolvedValue([])}));
vi.mock("../server/timezone-config.js", async importOriginal => ({...await importOriginal<typeof import("../server/timezone-config.js")>(),describeUserNow:vi.fn().mockResolvedValue({isExplicit:false,timezone:"UTC",now:"test"})}));
vi.mock("../server/memory/extract.js", () => ({extractAndStore:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../server/runtimes/index.js", () => ({runAgentRuntime:vi.fn()}));
import { handleUserMessage } from "../server/interaction-agent.js";
import { convex } from "../server/convex-client.js";
import { runAgentRuntime } from "../server/runtimes/index.js";
import { extractAndStore } from "../server/memory/extract.js";
describe("note intake through the message handler", () => {
  beforeEach(() => vi.clearAllMocks());
  it("saves complete text, acknowledges after storage, and uses extraction only", async () => {
    const paragraph = "I'm Mira. I live in Lisbon. I use Google Calendar.";
    const reply = await handleUserMessage({conversationId:"fixture",content:`/remember ${paragraph}`,persistAssistantReply:true});
    expect(reply).toContain("Saved your full note");
    expect(runAgentRuntime).not.toHaveBeenCalled();
    expect(extractAndStore).toHaveBeenCalledWith(expect.objectContaining({userMessage:paragraph}));
    const writes = vi.mocked(convex.mutation).mock.calls.map(call => call[1]);
    const rawIndex = writes.findIndex(args => args.content === `User note: ${paragraph}`);
    const replyIndex = writes.findIndex(args => args.role === "assistant");
    expect(rawIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(rawIndex);
  });
  it("asks for text without invoking a model for an empty command", async () => {
    const reply = await handleUserMessage({conversationId:"fixture",content:"/remember"});
    expect(reply).toContain("followed by");
    expect(extractAndStore).not.toHaveBeenCalled();
    expect(runAgentRuntime).not.toHaveBeenCalled();
  });
});
