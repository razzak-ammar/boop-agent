import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { reconcileMemory } from "./reconcile.js";
import { DEFAULT_DECAY, SEGMENT_PREFERRED_TIER, makeMemoryId } from "./types.js";

const NAMESPACE = "boop-memory";

export interface MemoryToolOptions {
  runtimeConfig?: RuntimeConfig;
  turnId?: string;
  /** Lets the turn tell background extraction what was already saved. */
  onWrite?: (content: string) => void;
}

const tierEnum = z.enum(["short", "long", "permanent"]);
const segmentEnum = z.enum([
  "identity",
  "preference",
  "correction",
  "relationship",
  "project",
  "knowledge",
  "context",
]);

export function createMemoryTools(conversationId: string, opts: MemoryToolOptions = {}): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "write_memory",
      "Persist an explicitly supplied durable personal fact or scoped standing preference. Do not infer a standing preference from a one-time request, tool error, or assistant claim. Recall existing facts first when correcting them; supersede only the conflicting memory IDs, preserving unrelated details. Never claim success until this tool succeeds.",
      {
        content: z.string().describe("The fact to remember, in one clear sentence."),
        segment: segmentEnum.describe(
          "identity: core facts about who they are. preference: scoped standing defaults. correction: explicitly corrected durable personal facts/preferences. relationship: people they know. project: ongoing work. knowledge: facts about their world. context: current situation.",
        ),
        importance: z.number().min(0).max(1).describe("0-1; how critical to retain."),
        tier: tierEnum.optional().describe("Override; defaults by segment."),
        supersedes: z
          .array(z.string())
          .optional()
          .describe("memoryId(s) this replaces (will be archived)."),
      },
      async (args) => {
        const tier = args.tier ?? SEGMENT_PREFERRED_TIER[args.segment];
        const memoryId = makeMemoryId();
        const embedding = (await embed(args.content)) ?? undefined;
        const id = await convex.mutation(api.memoryRecords.upsert, {
          memoryId,
          content: args.content,
          tier,
          segment: args.segment,
          importance: args.importance,
          decayRate: DEFAULT_DECAY[tier],
          supersedes: args.supersedes,
          embedding,
          deduplicate: true,
          requireActiveSupersedes: true,
        });
        const [stored] = await convex.query(api.memoryRecords.getByIds, { ids: [id] });
        if (!stored) throw new Error("Stored memory could not be read back.");
        await convex.mutation(api.memoryEvents.emit, {
          eventType: "memory.written",
          conversationId,
          memoryId: stored.memoryId,
          data: JSON.stringify({ tier, segment: args.segment, importance: args.importance }),
        });
        opts.onWrite?.(stored.content);
        // Off the reply path: reconciling may need a model call.
        void reconcileMemory({
          memoryId: stored.memoryId, content: stored.content, segment: stored.segment,
          embedding: embedding ?? stored.embedding, runtimeConfig: opts.runtimeConfig,
          conversationId, turnId: opts.turnId,
        });
        return runtimeText(`Stored ${stored.memoryId} (tier=${stored.tier}, segment=${stored.segment}).`);
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "forget_memory",
      "Remove a personal memory from active recall at the user's request. Recall first to obtain exact IDs. This archives the memory; it is not permanent erasure of chat history or backups. Do not use this to delete saved notes or collections.",
      { memoryIds: z.array(z.string()).min(1).max(20) },
      async ({ memoryIds }) => {
        let archived = 0;
        for (const memoryId of new Set(memoryIds)) {
          const id = await convex.mutation(api.memoryRecords.setLifecycle, { memoryId, lifecycle: "archived" });
          if (id) archived++;
        }
        await convex.mutation(api.memoryEvents.emit, { eventType: "memory.forgotten", conversationId, data: JSON.stringify({ memoryIds, archived }) });
        return runtimeText(`Archived ${archived} personal memories from active recall.`);
      },
    ),

    recallTool(conversationId),
  ];
}

/** Read-only memory access for workers, which act on preferences beyond the bounded profile. */
export function createRecallTools(conversationId?: string): RuntimeTool[] {
  return [recallTool(conversationId)];
}

function recallTool(conversationId?: string): RuntimeTool {
  return defineRuntimeTool(
    NAMESPACE,
    "recall",
    "Search your memories for anything relevant to the current turn. Call this early in any conversation that touches the user's preferences, projects, or past decisions.",
    {
      query: z.string().describe("Keywords or topic to search for."),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      let results: any[] = [];
      let mode: "vector" | "substring" = "substring";

      if (embeddingsAvailable()) {
        const queryVec = await embed(args.query);
        if (queryVec) {
          const hits = await convex.action(api.memoryRecords.vectorSearch, {
            embedding: queryVec,
            limit: args.limit,
          });
          results = hits.map((h) => h.record);
          mode = "vector";
        }
      }
      if (results.length === 0) {
        results = await convex.query(api.memoryRecords.search, {
          query: args.query,
          limit: args.limit,
        });
      }

      for (const r of results) {
        await convex.mutation(api.memoryRecords.markAccessed, { memoryId: r.memoryId });
      }
      await convex.mutation(api.memoryEvents.emit, {
        eventType: "memory.recalled",
        conversationId,
        data: JSON.stringify({ query: args.query, hits: results.length, mode }),
      });
      if (results.length === 0) {
        return runtimeText("No memories matched.");
      }
      const body = results
        .map(
          (r) =>
            `• [${r.tier}/${r.segment} importance=${r.importance.toFixed(2)}] ${r.memoryId}: ${r.content}`,
        )
        .join("\n");
      return runtimeText(body);
    },
  );
}

export function createMemoryMcp(conversationId: string) {
  return createClaudeMcpServer(NAMESPACE, createMemoryTools(conversationId));
}
