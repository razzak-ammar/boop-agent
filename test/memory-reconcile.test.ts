import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({convex:{query:vi.fn(),mutation:vi.fn(),action:vi.fn()}}));
vi.mock("../server/embeddings.js", () => ({embed:vi.fn().mockResolvedValue([0.5]),embeddingsAvailable:()=>true}));
vi.mock("../server/runtimes/index.js", () => ({runAgentRuntime:vi.fn()}));
vi.mock("../server/images/content-blocks.js", () => ({buildPromptWithImages:vi.fn(),fetchStoredBytes:vi.fn()}));
import { convex } from "../server/convex-client.js";
import { runAgentRuntime } from "../server/runtimes/index.js";
import { parseReconcileDecision, reconcileMemory } from "../server/memory/reconcile.js";
import { extractAndStore } from "../server/memory/extract.js";

const config = {runtime:"codex",model:"gpt-6-luna",reasoningEffort:"low",billingMode:"codex-subscription"} as never;
const usage = {inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,costUsd:0,model:"gpt-6-luna"};
const record = (memoryId: string, content: string) => ({memoryId, content, segment:"preference", createdAt:0});

describe("reconcile decisions", () => {
  it("accepts drops and only candidate replacements, defaulting to keep", () => {
    expect(parseReconcileDecision('{"action":"drop","replaces":["a"]}', ["a"])).toEqual({action:"drop",replaces:[]});
    expect(parseReconcileDecision('{"action":"keep","replaces":["a","made-up"],"content":"merged"}', ["a"])).toEqual({action:"keep",replaces:["a"],content:"merged"});
    expect(parseReconcileDecision('{"action":"keep","replaces":["made-up"],"content":"merged"}', ["a"])).toEqual({action:"keep",replaces:[]});
    expect(parseReconcileDecision("not json", ["a"])).toEqual({action:"keep",replaces:[]});
    expect(parseReconcileDecision('{"action":"merge"}', ["a"])).toEqual({action:"keep",replaces:[]});
  });
});

describe("reconcileMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(convex.mutation).mockResolvedValue("dropped");
  });
  it("skips the model when no stored memory is similar enough", async () => {
    vi.mocked(convex.action).mockResolvedValue([
      {score:1, record:record("self","x")},
      {score:0.79, record:record("far","y")},
    ]);
    expect(await reconcileMemory({memoryId:"self",content:"x",segment:"preference",embedding:[1],runtimeConfig:config})).toBe("kept");
    expect(runAgentRuntime).not.toHaveBeenCalled();
  });
  it("asks the model about near matches and applies its decision atomically", async () => {
    vi.mocked(convex.action).mockResolvedValue([{score:0.93, record:record("old","No Meet links")}]);
    vi.mocked(runAgentRuntime).mockResolvedValue({text:'{"action":"drop"}',usage} as never);
    expect(await reconcileMemory({memoryId:"new",content:"Never add Meet links",segment:"preference",embedding:[1],runtimeConfig:config})).toBe("dropped");
    const prompt = JSON.parse(vi.mocked(runAgentRuntime).mock.calls[0][1].prompt as string);
    expect(prompt.EXISTING.map((row: {memoryId: string}) => row.memoryId)).toEqual(["old"]);
    expect(vi.mocked(convex.mutation).mock.calls.map(call => call[1])).toContainEqual(
      {memoryId:"new",candidateIds:["old"],drop:true,replaces:[],content:undefined,embedding:undefined});
  });
  it("leaves the new memory alone when reconciliation fails", async () => {
    vi.mocked(convex.action).mockRejectedValue(new Error("offline"));
    expect(await reconcileMemory({memoryId:"new",content:"x",segment:"preference",embedding:[1],runtimeConfig:config})).toBe("kept");
  });
});

describe("background extraction after foreground writes", () => {
  beforeEach(() => vi.clearAllMocks());
  it("tells the extractor what this turn already saved, then reconciles new facts", async () => {
    vi.mocked(convex.query).mockImplementation(async (_fn, args) =>
      args && "ids" in (args as object) ? [{...record("mem_new","User prefers window seats"), embedding:[0.5]}] : []);
    vi.mocked(convex.mutation).mockResolvedValue("row_id");
    vi.mocked(convex.action).mockResolvedValue([]);
    vi.mocked(runAgentRuntime).mockResolvedValue({text:JSON.stringify({facts:[
      {content:"User prefers window seats",segment:"preference",evidence:"I like window seats"},
    ]}),usage} as never);
    await extractAndStore({conversationId:"c",userMessage:"Never use emoji. I like window seats",assistantReply:"Noted",turnId:"t",runtimeConfig:config,
      alreadySaved:["User prefers that I never use emoji."]});
    const prompt = vi.mocked(runAgentRuntime).mock.calls[0][1].prompt as string;
    expect(prompt).toContain('SAVED THIS TURN:\n["User prefers that I never use emoji."]');
    // The stored fact was checked against similar memories.
    expect(convex.action).toHaveBeenCalledWith(expect.anything(), {embedding:[0.5],limit:5});
  });
});
