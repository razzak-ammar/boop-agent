import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const kind = v.union(v.literal("note"), v.literal("link"), v.literal("image"));
function required(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${label} must contain 1–${max} characters.`);
  return text;
}
function collectionName(name: string) {
  const display = required(name, "Collection name", 100).replace(/\s+/g, " ");
  return { name: display, key: display.normalize("NFKC").toLowerCase() };
}
async function findCollection(ctx: QueryCtx | MutationCtx, name: string) {
  return ctx.db.query("savedCollections").withIndex("by_key", q => q.eq("key", collectionName(name).key)).unique();
}
async function ensureCollection(ctx: MutationCtx, name: string): Promise<Id<"savedCollections">> {
  const existing = await findCollection(ctx, name);
  return existing?._id ?? ctx.db.insert("savedCollections", { ...collectionName(name), createdAt: Date.now() });
}
function checkedUrls(urls: string[]) {
  if (urls.length > 30) throw new Error("Save at most 30 links per item.");
  return [...new Set(urls.map(raw => {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || raw.length > 4096) {
      throw new Error("Links must be HTTP(S) URLs without credentials.");
    }
    return url.href;
  }))];
}
function searchText(title: string, content: string, urls: string[], recommendedBy?: string) {
  return [title, content, recommendedBy ?? "", ...urls].join("\n");
}

export const createCollection = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => ensureCollection(ctx, args.name),
});
export const listCollections = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => ctx.db.query("savedCollections").withIndex("by_key").paginate(args.paginationOpts),
});

export const save = mutation({
  args: {
    collection: v.string(), title: v.string(), content: v.string(), kind,
    status: v.optional(v.string()), recommendedBy: v.optional(v.string()),
    urls: v.optional(v.array(v.string())), imageStorageIds: v.optional(v.array(v.id("_storage"))),
    sourceConversationId: v.string(), sourceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Stable transport/turn keys make explicit capture safe to replay.
    if (args.sourceKey) {
      const existing = await ctx.db.query("savedItems").withIndex("by_sourceKey", q => q.eq("sourceKey", args.sourceKey)).unique();
      if (existing) return existing._id;
    }
    const title = required(args.title, "Title", 300);
    if (args.content.length > 100_000) throw new Error("Note exceeds 100,000 characters.");
    const urls = checkedUrls(args.urls ?? []);
    const imageStorageIds = [...new Set(args.imageStorageIds ?? [])];
    if (imageStorageIds.length > 10) throw new Error("Save at most 10 images per item.");
    for (const id of imageStorageIds) {
      if (!(await ctx.db.system.get("_storage", id))) throw new Error("Image attachment does not exist.");
    }
    const collectionId = await ensureCollection(ctx, args.collection);
    const now = Date.now();
    return ctx.db.insert("savedItems", {
      collectionId, title, content: args.content, kind: args.kind,
      status: required(args.status ?? "saved", "Status", 60),
      recommendedBy: args.recommendedBy?.trim() || undefined,
      urls, imageStorageIds, sourceConversationId: args.sourceConversationId,
      sourceKey: args.sourceKey,
      searchText: searchText(title, args.content, urls, args.recommendedBy),
      createdAt: now, updatedAt: now,
    });
  },
});

export const list = query({
  args: {
    collection: v.optional(v.string()), status: v.optional(v.string()),
    search: v.optional(v.string()), paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const collection = args.collection ? await findCollection(ctx, args.collection) : null;
    if (args.collection && !collection) return { page: [], isDone: true, continueCursor: "" };
    if (args.search?.trim()) {
      return ctx.db.query("savedItems").withSearchIndex("search_text", q => {
        let search = q.search("searchText", args.search!.trim());
        if (collection) search = search.eq("collectionId", collection._id);
        if (args.status) search = search.eq("status", args.status);
        return search;
      }).paginate(args.paginationOpts);
    }
    const items = collection
      ? args.status
        ? ctx.db.query("savedItems").withIndex("by_collectionId_and_status", q => q.eq("collectionId", collection._id).eq("status", args.status!))
        : ctx.db.query("savedItems").withIndex("by_collectionId", q => q.eq("collectionId", collection._id))
      : args.status
        ? ctx.db.query("savedItems").withIndex("by_status", q => q.eq("status", args.status!))
        : ctx.db.query("savedItems");
    return items.order("desc").paginate(args.paginationOpts);
  },
});
export const get = query({
  args: { id: v.id("savedItems") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});
export const getBySourceKey = query({
  args: { sourceKey: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db.query("savedItems").withIndex("by_sourceKey", q => q.eq("sourceKey", args.sourceKey)).unique();
    if (!item) return null;
    const imageMediaTypes = await Promise.all(item.imageStorageIds.map(async id => (await ctx.db.system.get("_storage", id))?.contentType ?? "image/jpeg"));
    return { ...item, imageMediaTypes };
  },
});
export const update = mutation({
  args: {
    id: v.id("savedItems"), title: v.optional(v.string()), content: v.optional(v.string()),
    collection: v.optional(v.string()), status: v.optional(v.string()), recommendedBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item) throw new Error("Saved item not found.");
    const title = args.title === undefined ? item.title : required(args.title, "Title", 300);
    const content = args.content ?? item.content;
    if (content.length > 100_000) throw new Error("Note exceeds 100,000 characters.");
    const recommendedBy = args.recommendedBy === undefined ? item.recommendedBy : args.recommendedBy.trim() || undefined;
    await ctx.db.patch(args.id, {
      title, content, recommendedBy,
      status: args.status === undefined ? item.status : required(args.status, "Status", 60),
      collectionId: args.collection ? await ensureCollection(ctx, args.collection) : item.collectionId,
      searchText: searchText(title, content, item.urls, recommendedBy), updatedAt: Date.now(),
    });
    return args.id;
  },
});
export const remove = mutation({
  args: { id: v.id("savedItems") },
  handler: async (ctx, args) => {
    // Blobs can also belong to messages/memory. The existing image cleanup
    // reclaims them when no saved item or memory references them anymore.
    await ctx.db.delete(args.id);
    return args.id;
  },
});

export const findImageRefsPage = query({
  args: { storageIds: v.array(v.id("_storage")), cursor: v.optional(v.union(v.string(), v.null())), pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const wanted = new Set(args.storageIds);
    const result = await ctx.db.query("savedItems").paginate({ cursor: args.cursor ?? null, numItems: args.pageSize ?? 50 });
    return {
      foundStorageIds: [...new Set(result.page.flatMap(item => item.imageStorageIds.filter(id => wanted.has(id))))],
      isDone: result.isDone, continueCursor: result.continueCursor,
    };
  },
});
