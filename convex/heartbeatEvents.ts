import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import schema from "./schema.js";

const RETENTION_MS = 30 * 86400000;
const PRUNE_BATCH = 50;

const fields = schema.tables.heartbeatEvents.validator.fields;

/** Records one heartbeat event and prunes old ones. Returns the row id so a
 * "sending" event can be marked sent or failed after delivery. */
export const record = mutation({
  args: fields,
  returns: v.id("heartbeatEvents"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("heartbeatEvents", args);
    const cutoff = args.at - RETENTION_MS;
    const old = await ctx.db
      .query("heartbeatEvents")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    return id;
  },
});

export const setOutcome = mutation({
  args: {
    id: v.id("heartbeatEvents"),
    outcome: v.union(v.literal("sent"), v.literal("send_failed")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row) await ctx.db.patch(args.id, { outcome: args.outcome });
    return null;
  },
});

/** Newest first, for the dashboard. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("heartbeatEvents")
      .withIndex("by_at")
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 50, 1), 200));
  },
});
