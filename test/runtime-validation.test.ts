import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSDKProvider } from "@composio/claude-agent-sdk";
import { createClaudeMcpServer } from "../server/runtimes/claude.js";
import { defineRuntimeTool } from "../server/runtimes/tool.js";
import { runtimeText } from "../server/runtimes/types.js";
import { zodShapeToJsonSchema } from "../server/runtimes/json-schema.js";

describe("patched validation and tool SDK compatibility", () => {
  it.each(["bad", null])("rejects oversized invalid arrays without expanding per-item errors (%s)", (value) => {
    const result = z.array(z.number()).max(2).safeParse(Array(10000).fill(value));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].code).toBe("too_big");
    }
    expect(z.array(z.number()).max(2).parse([1, 2])).toEqual([1, 2]);
  });

  it("preserves tool schemas, optional defaults, bounds, nested objects, and nullable values", () => {
    const schema = zodShapeToJsonSchema({
      tier: z.enum(["short", "long"]).describe("Memory tier"),
      integrations: z.array(z.string()).default([]),
      limit: z.number().min(1).max(10).optional(),
      details: z.object({ note: z.string().nullable() }),
    });
    expect(schema).toMatchObject({
      type: "object", required: ["tier", "details"], additionalProperties: false,
      properties: {
        tier: { type: "string", enum: ["short", "long"], description: "Memory tier" },
        integrations: { type: "array", items: { type: "string" } },
        limit: { type: "number", minimum: 1, maximum: 10 },
        details: { type: "object", required: ["note"], additionalProperties: false, properties: { note: { type: ["string", "null"] } } },
      },
    });
  });

  it("applies defaults and rejects invalid arguments before calling a runtime tool", async () => {
    const handler = vi.fn(async () => runtimeText("ok"));
    const tool = defineRuntimeTool("test", "remember", "Remember", {
      tier: z.enum(["short", "long"]), tags: z.array(z.string()).default([]),
    }, handler);
    await tool.handle({ tier: "long" });
    expect(handler).toHaveBeenCalledWith({ tier: "long", tags: [] });
    await expect(tool.handle({ tier: "bogus" })).rejects.toThrow();
    await expect(tool.handle({ tier: "long", tags: [123] })).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lists and invokes a Boop tool through the upgraded Claude MCP SDK", async () => {
    const tool = defineRuntimeTool("test", "remember", "Remember", {
      tier: z.enum(["short", "long"]), tags: z.array(z.string()).default([]),
    }, async (args) => runtimeText(JSON.stringify(args)));
    const server = createClaudeMcpServer("test", [tool]);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools[0].inputSchema.properties?.tier).toMatchObject({ enum: ["short", "long"] });
      const result = await client.callTool({ name: "remember", arguments: { tier: "long" } });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ tier: "long", tags: [] }) }]);
    } finally { await client.close(); await server.instance.close(); }
  });

  it("converts and invokes Composio tools with the coordinated provider/core/Zod upgrade", async () => {
    const execute = vi.fn(async () => ({ successful: true, data: { events: [] } }));
    const wrapped = new ClaudeAgentSDKProvider().wrapTool({
      slug: "LIST_EVENTS", description: "Read events", name: "List events",
      inputParameters: { type: "object", properties: { calendar: { type: "string" } }, required: ["calendar"] },
    } as never, execute);
    const server = createSdkMcpServer({ name: "composio-test", tools: [wrapped] });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools[0].inputSchema.properties?.calendar).toMatchObject({ type: "string" });
      const result = await client.callTool({ name: "LIST_EVENTS", arguments: { calendar: "primary" } });
      expect(result.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledWith("LIST_EVENTS", expect.objectContaining({ calendar: "primary" }));
    } finally { await client.close(); await server.instance.close(); }
  });
});
