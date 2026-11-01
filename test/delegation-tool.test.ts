import {describe,it,expect,vi} from "vitest";
vi.mock("../server/convex-client.js",()=>({convex:{query:vi.fn().mockResolvedValue([]),mutation:vi.fn().mockResolvedValue(null)}}));
vi.mock("../server/broadcast.js",()=>({broadcast:vi.fn()}));
vi.mock("../server/memory/extract.js",()=>({extractAndStore:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../server/notifications.js",()=>({sendConversationNotification:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../server/execution-agent.js",()=>({availableIntegrations:()=>["googlecalendar"],spawnExecutionAgent:vi.fn().mockResolvedValue({agentId:"fixture_agent",status:"completed",result:"Found Meetings calendar."})}));
vi.mock("../server/runtime-config.js",async original=>({...await original<typeof import("../server/runtime-config.js")>(),getRuntimeConfig:vi.fn().mockResolvedValue({runtime:"codex",model:"gpt-6-luna",billingMode:"codex-subscription"})}));
vi.mock("../server/integrations/registry.js",async original=>({...await original<typeof import("../server/integrations/registry.js")>(),listEnabledIntegrations:vi.fn().mockResolvedValue([{name:"googlecalendar"}])}));
vi.mock("../server/timezone-config.js",async original=>({...await original<typeof import("../server/timezone-config.js")>(),describeUserNow:vi.fn().mockResolvedValue({isExplicit:true,timezone:"America/New_York",now:"2026-11-01T14:00:00-05:00"})}));
vi.mock("../server/runtimes/index.js",()=>({runAgentRuntime:vi.fn()}));
import {handleUserMessage} from "../server/interaction-agent.js";
import {runAgentRuntime} from "../server/runtimes/index.js";
import {spawnExecutionAgent} from "../server/execution-agent.js";
import {BOOP_DELEGATE_TOOL} from "../server/interaction-prompt.js";
import {EMPTY_USAGE} from "../server/usage.js";
describe("application-owned delegation",()=>{
  it("registers, permits, and invokes Boop's worker without colliding with native spawn_agent",async()=>{
    vi.mocked(runAgentRuntime).mockImplementationOnce(async (_config,request)=>{
      expect(request.tools.some(tool=>tool.name==="spawn_agent")).toBe(false);
      expect(request.allowedTools).toContain(`mcp__boop-spawn__${BOOP_DELEGATE_TOOL}`);
      expect(request.systemPrompt).toContain(BOOP_DELEGATE_TOOL);
      const tool=request.tools.find(tool=>tool.name===BOOP_DELEGATE_TOOL)!;
      const result=await tool.handle({task:"List Google Calendar calendars and find Meetings",integrations:["googlecalendar"],name:"Calendar list"});
      expect(result.text).toContain("Found Meetings calendar");
      return{text:result.text,usage:EMPTY_USAGE};
    });
    const reply=await handleUserMessage({conversationId:"fixture",content:"Check my Google Calendar calendar list for Meetings."});
    expect(reply).toContain("Found Meetings calendar");
    expect(spawnExecutionAgent).toHaveBeenCalledWith(expect.objectContaining({integrations:["googlecalendar"],task:"List Google Calendar calendars and find Meetings"}));
  });
});
