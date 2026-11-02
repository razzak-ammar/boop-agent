import { action, mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DEMO_SCAN_LIMIT, isDemoId, isDemoModeEnabled } from "./demoMode";

const tierV = v.union(v.literal("short"), v.literal("long"), v.literal("permanent"));
const segmentV = v.union(
  v.literal("identity"),
  v.literal("preference"),
  v.literal("correction"),
  v.literal("relationship"),
  v.literal("project"),
  v.literal("knowledge"),
  v.literal("context"),
);
const lifecycleV = v.union(v.literal("active"), v.literal("archived"), v.literal("pruned"));

type MemoryTier = "short" | "long" | "permanent";
type MemorySegment =
  | "identity"
  | "preference"
  | "correction"
  | "relationship"
  | "project"
  | "knowledge"
  | "context";
type MemoryLifecycle = "active" | "archived" | "pruned";

export const upsert = mutation({
  args: {
    memoryId: v.string(),
    content: v.string(),
    tier: tierV,
    segment: segmentV,
    importance: v.number(),
    decayRate: v.number(),
    sourceTurn: v.optional(v.string()),
    supersedes: v.optional(v.array(v.string())),
    embedding: v.optional(v.array(v.float64())),
    metadata: v.optional(v.string()),
    imageStorageIds: v.optional(v.union(v.array(v.id("_storage")), v.null())),
    deduplicate: v.optional(v.boolean()),
    requireActiveSupersedes: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { deduplicate, requireActiveSupersedes, ...storedArgs } = args;
    // Resolve all replacement targets before writing, inside this transaction.
    const targets = await Promise.all((args.supersedes ?? []).filter(id => id !== args.memoryId).map(memoryId =>
      ctx.db.query("memoryRecords").withIndex("by_memory_id", q => q.eq("memoryId", memoryId)).unique(),
    ));
    if (requireActiveSupersedes && targets.some(row => !row || row.lifecycle !== "active")) {
      throw new Error("Memory correction is stale; recall current facts before replacing them.");
    }

    const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
    const duplicate = deduplicate && !args.imageStorageIds?.length
      ? (await ctx.db.query("memoryRecords").withIndex("by_lifecycle", q => q.eq("lifecycle", "active"))
          .order("desc").take(500)).find(row => !isDemoId(row.memoryId) && !row.imageStorageIds?.length &&
            !(args.supersedes ?? []).includes(row.memoryId) && normalize(row.content) === normalize(args.content))
      : undefined;

    // Archive any memories this one supersedes. Must run on BOTH the insert
    // and update paths — consolidation merges typically update an existing
    // "keep" memory while archiving the ones it absorbed.
    if (targets.length) {
      for (const target of targets) {
        if (target && target.lifecycle === "active") {
          await ctx.db.patch(target._id, { lifecycle: "archived" });
        }
      }
    }

    const existing = duplicate ?? await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content,
        tier: deduplicate && existing.tier === "permanent" ? "permanent" : args.tier,
        segment: args.segment,
        importance: args.importance,
        decayRate: args.decayRate,
        supersedes: [...new Set([...(existing.supersedes ?? []), ...(args.supersedes ?? [])])],
        embedding: args.embedding ?? existing.embedding,
        metadata: args.metadata ?? existing.metadata,
        imageStorageIds:
          args.imageStorageIds === null
            ? undefined
            : args.imageStorageIds && args.imageStorageIds.length > 0
              ? args.imageStorageIds
              : existing.imageStorageIds,
        lastAccessedAt: now,
      });
      return existing._id;
    }

    const { imageStorageIds, ...rest } = storedArgs;
    return await ctx.db.insert("memoryRecords", {
      ...rest,
      ...(imageStorageIds && imageStorageIds.length > 0
        ? { imageStorageIds }
        : {}),
      accessCount: 0,
      lastAccessedAt: now,
      lifecycle: "active",
      createdAt: now,
    });
  },
});

export const getByIds = query({
  args: { ids: v.array(v.id("memoryRecords")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const r = await ctx.db.get(id);
      if (r && !isDemoId(r.memoryId)) out.push(r);
    }
    return out;
  },
});

// Applies a reconcile decision in one transaction. Two writes of the same fact
// can each name the other as a duplicate; whichever reconciles first wins and
// the second finds no active candidate, so one copy always survives.
export const reconcile = mutation({
  args: {
    memoryId: v.string(),
    candidateIds: v.array(v.string()),
    drop: v.boolean(),
    replaces: v.array(v.string()),
    content: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args): Promise<"kept" | "dropped" | "replaced" | "missing"> => {
    const find = (memoryId: string) =>
      ctx.db.query("memoryRecords").withIndex("by_memory_id", q => q.eq("memoryId", memoryId)).unique();
    const row = await find(args.memoryId);
    if (!row || row.lifecycle !== "active") return "missing";
    const candidates = (await Promise.all(args.candidateIds.filter(id => id !== args.memoryId).map(find)))
      .filter((candidate): candidate is Doc<"memoryRecords"> => candidate?.lifecycle === "active");
    if (args.drop) {
      if (!candidates.length) return "kept";
      await ctx.db.patch(row._id, { lifecycle: "archived" });
      // Restating a fact means it still matters; carry the stronger retention.
      const keep = candidates[0];
      await ctx.db.patch(keep._id, {
        importance: Math.max(keep.importance, row.importance),
        tier: row.tier === "permanent" ? "permanent" : keep.tier,
        decayRate: Math.min(keep.decayRate, row.decayRate),
        lastAccessedAt: Date.now(),
      });
      return "dropped";
    }
    const replaced = candidates.filter(candidate => args.replaces.includes(candidate.memoryId));
    if (!replaced.length) return "kept";
    for (const candidate of replaced) await ctx.db.patch(candidate._id, { lifecycle: "archived" });
    await ctx.db.patch(row._id, {
      supersedes: [...new Set([...(row.supersedes ?? []), ...replaced.map(candidate => candidate.memoryId)])],
      ...(args.content?.trim() ? { content: args.content.trim(), embedding: args.embedding ?? row.embedding } : {}),
    });
    return "replaced";
  },
});

const PROFILE_SEGMENT_LIMITS = { identity: 15, preference: 40, correction: 25 } as const;

// Segment indexes keep background context from crowding out stable preferences.
// Rank by importance and use rather than recency so a burst of new memories
// cannot push older standing preferences out of the always-loaded profile.
export const profile = query({
  args: {},
  handler: async (ctx) => {
    const groups = await Promise.all((Object.keys(PROFILE_SEGMENT_LIMITS) as Array<keyof typeof PROFILE_SEGMENT_LIMITS>).map(async segment =>
      (await ctx.db.query("memoryRecords").withIndex("by_segment", q => q.eq("segment", segment)).order("desc").take(300))
        .filter(row => row.lifecycle === "active" && !isDemoId(row.memoryId))
        .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount || b.createdAt - a.createdAt)
        .slice(0, PROFILE_SEGMENT_LIMITS[segment]),
    ));
    return groups.flat()
      .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount || b.createdAt - a.createdAt)
      .map(({ memoryId, content, segment, createdAt }) => ({ memoryId, content, segment, createdAt }));
  },
});

export const vectorSearch = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ _id: Id<"memoryRecords">; score: number; record: Doc<"memoryRecords"> }>
  > => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 256));
    const results = await ctx.vectorSearch("memoryRecords", "by_embedding", {
      vector: args.embedding,
      // Demo vectors share the same index. Oversample enough to filter them
      // without allowing seeded showcase data into real memory recall.
      limit: Math.min(256, limit + 100),
      filter: (q) => q.eq("lifecycle", "active"),
    });
    const records = await ctx.runQuery(api.memoryRecords.getByIds, {
      ids: results.map((r) => r._id),
    });
    const byId = new Map(records.map((record) => [record._id, record]));
    return results
      .map((r) => ({ _id: r._id, score: r._score, record: byId.get(r._id) }))
      .filter(
        (result): result is {
          _id: Id<"memoryRecords">;
          score: number;
          record: Doc<"memoryRecords">;
        } => Boolean(result.record),
      )
      .slice(0, limit);
  },
});

type MemoryListArgs = {
  tier?: MemoryTier;
  segment?: MemorySegment;
  lifecycle?: MemoryLifecycle;
  limit?: number;
};

async function readMemories(ctx: QueryCtx, args: MemoryListArgs, demoOnly: boolean) {
  const limit = args.limit ?? 100;
  const results = args.tier
    ? await ctx.db
        .query("memoryRecords")
        .withIndex("by_tier", (q) => q.eq("tier", args.tier!))
        .order("desc")
        .take(DEMO_SCAN_LIMIT)
    : args.segment
      ? await ctx.db
          .query("memoryRecords")
          .withIndex("by_segment", (q) => q.eq("segment", args.segment!))
          .order("desc")
          .take(DEMO_SCAN_LIMIT)
      : await ctx.db.query("memoryRecords").order("desc").take(DEMO_SCAN_LIMIT);
  const lifecycle = args.lifecycle ?? "active";
  return results
    .filter((record) => isDemoId(record.memoryId) === demoOnly && record.lifecycle === lifecycle)
    .slice(0, limit);
}

const listArgs = {
  tier: v.optional(tierV),
  segment: v.optional(segmentV),
  lifecycle: v.optional(lifecycleV),
  limit: v.optional(v.number()),
};

export const list = query({
  args: listArgs,
  handler: async (ctx, args) => readMemories(ctx, args, false),
});

export const listForDashboard = query({
  args: listArgs,
  handler: async (ctx, args) => {
    return readMemories(ctx, args, await isDemoModeEnabled(ctx));
  },
});

export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const q = args.query.toLowerCase();
    // Filter on the index BEFORE the 500 cap — otherwise archived/pruned
    // records eat the budget and silently truncate the active set.
    // order("desc") so the 500-cap favors recent records. Without it the
    // index iterates oldest-first and a brand-new high-importance record
    // past position 500 would never be seen.
    const active = await ctx.db
      .query("memoryRecords")
      .withIndex("by_lifecycle", (idx) => idx.eq("lifecycle", "active"))
      .order("desc")
      .take(500);
    return active
      .filter((m) => !isDemoId(m.memoryId) && m.content.toLowerCase().includes(q))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  },
});

export const markAccessed = mutation({
  args: { memoryId: v.string() },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.patch(mem._id, {
      accessCount: mem.accessCount + 1,
      lastAccessedAt: Date.now(),
    });
    return mem._id;
  },
});

export const setLifecycle = mutation({
  args: { memoryId: v.string(), lifecycle: lifecycleV },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.patch(mem._id, { lifecycle: args.lifecycle });
    return mem._id;
  },
});

export const remove = mutation({
  args: { memoryId: v.string() },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.delete(mem._id);
    await ctx.db.insert("memoryEvents", {
      eventType: "memory.deleted",
      memoryId: args.memoryId,
      data: JSON.stringify({
        tier: mem.tier,
        segment: mem.segment,
        lifecycle: mem.lifecycle,
      }),
      createdAt: Date.now(),
    });
    return mem._id;
  },
});

const COUNTS_SCAN_LIMIT = 5000;

export const embeddingStats = query({
  args: {},
  handler: async (ctx) => {
    let all = await ctx.db
      .query("memoryRecords")
      .withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active"))
      .order("desc")
      .take(COUNTS_SCAN_LIMIT);
    const scanned = all.length;
    all = all.filter((memory) => !isDemoId(memory.memoryId));
    let withEmbedding = 0;
    let withoutEmbedding = 0;
    for (const m of all) {
      if (m.embedding && m.embedding.length > 0) withEmbedding++;
      else withoutEmbedding++;
    }
    return {
      total: all.length,
      withEmbedding,
      withoutEmbedding,
      truncated: scanned === COUNTS_SCAN_LIMIT,
    };
  },
});

// Cursor-based scan over active memories that yields the unembedded ones.
// Returns at most `pageSize` rows from the underlying index, and the caller
// is expected to walk pages via `continueCursor` until `isDone`. A given
// page may contain fewer unembedded rows than were scanned (the rest had
// embeddings and were filtered out).
//
// Why a cursor rather than a top-N sort by importance: the previous
// implementation took 5,000 rows per call and filtered in-process, so each
// pagination step was O(total memories). With the cursor each step is
// O(pageSize). Re-embed throughput is unchanged (we still process every
// unembedded row exactly once) but Convex query cost stays bounded as the
// memory corpus grows.
export const listUnembeddedPage = query({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("memoryRecords")
      .withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active"))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: args.pageSize ?? 50,
      });
    return {
      page: result.page
        .filter((m) => !isDemoId(m.memoryId) && (!m.embedding || m.embedding.length === 0))
        .map((m) => ({ memoryId: m.memoryId, content: m.content })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// Patch just the embedding on an existing memory. Avoids re-running upsert
// (which would touch lastAccessedAt + run supersedes processing) just to
// back-fill a vector.
export const setEmbedding = mutation({
  args: {
    memoryId: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.patch(mem._id, { embedding: args.embedding });
    return mem._id;
  },
});

export const countsByTier = query({
  args: {},
  handler: async (ctx) => {
    const demoMode = await isDemoModeEnabled(ctx);
    const rows = await ctx.db.query("memoryRecords").order("desc").take(COUNTS_SCAN_LIMIT);
    const all = rows.filter((m) => isDemoId(m.memoryId) === demoMode);
    const active = all.filter((m) => m.lifecycle === "active");
    return {
      short: active.filter((m) => m.tier === "short").length,
      long: active.filter((m) => m.tier === "long").length,
      permanent: active.filter((m) => m.tier === "permanent").length,
      archived: all.filter((m) => m.lifecycle === "archived").length,
      pruned: all.filter((m) => m.lifecycle === "pruned").length,
      truncated: rows.length === COUNTS_SCAN_LIMIT,
      scanLimit: COUNTS_SCAN_LIMIT,
    };
  },
});

export const findImageRefsPage = query({
  args: {
    storageIds: v.array(v.id("_storage")),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.storageIds.length === 0) {
      return { foundStorageIds: [], isDone: true, continueCursor: null };
    }
    const wanted = new Set(args.storageIds);
    const result = await ctx.db
      .query("memoryRecords")
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: args.pageSize ?? 50,
      });
    const found = new Set<string>();
    for (const record of result.page) {
      for (const storageId of record.imageStorageIds ?? []) {
        if (wanted.has(storageId)) found.add(storageId);
      }
    }
    return {
      foundStorageIds: [...found],
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
