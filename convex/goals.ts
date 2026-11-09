import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const milestone = v.object({
  date: v.string(),
  label: v.string(),
  target: v.optional(v.number()),
});
const status = v.union(v.literal("active"), v.literal("done"), v.literal("dropped"));
const MAX_MILESTONES = 30;

function checkDates(deadline: string | undefined, milestones: Array<{ date: string }> | undefined) {
  const dates = [...(deadline ? [deadline] : []), ...(milestones ?? []).map((m) => m.date)];
  if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)))
    throw new Error("Goal dates must be local YYYY-MM-DD.");
  if ((milestones?.length ?? 0) > MAX_MILESTONES)
    throw new Error(`A goal can have at most ${MAX_MILESTONES} milestones.`);
}

async function byGoalId(ctx: MutationCtx, goalId: string) {
  return await ctx.db
    .query("goals")
    .withIndex("by_goal_id", (q) => q.eq("goalId", goalId))
    .unique();
}

export const create = mutation({
  args: {
    goalId: v.string(),
    conversationId: v.string(),
    title: v.string(),
    deadline: v.string(),
    unit: v.optional(v.string()),
    total: v.optional(v.number()),
    progress: v.optional(v.number()),
    milestones: v.array(milestone),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    checkDates(args.deadline, args.milestones);
    const existing = await byGoalId(ctx, args.goalId);
    if (existing) return existing._id;
    const now = Date.now();
    return await ctx.db.insert("goals", {
      ...args,
      progress: args.progress ?? 0,
      milestones: [...args.milestones].sort((a, b) => a.date.localeCompare(b.date)),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    goalId: v.string(),
    conversationId: v.string(),
    title: v.optional(v.string()),
    deadline: v.optional(v.string()),
    unit: v.optional(v.string()),
    total: v.optional(v.number()),
    milestones: v.optional(v.array(milestone)),
    notes: v.optional(v.string()),
    status: v.optional(status),
  },
  handler: async (ctx, { goalId, conversationId, ...fields }) => {
    checkDates(fields.deadline, fields.milestones);
    const goal = await byGoalId(ctx, goalId);
    if (!goal || goal.conversationId !== conversationId) return null;
    const patch = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    if (fields.milestones)
      patch.milestones = [...fields.milestones].sort((a, b) => a.date.localeCompare(b.date));
    await ctx.db.patch(goal._id, { ...patch, updatedAt: Date.now() });
    return await ctx.db.get(goal._id);
  },
});

/** Progress is cumulative ("6 of 12 lectures"), not a delta, so a repeated
 * check-in reply can't double count. */
export const logProgress = mutation({
  args: {
    goalId: v.string(),
    conversationId: v.string(),
    progress: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const goal = await byGoalId(ctx, args.goalId);
    if (!goal || goal.conversationId !== args.conversationId) return null;
    const now = Date.now();
    await ctx.db.insert("goalUpdates", {
      goalId: args.goalId,
      progress: args.progress,
      note: args.note,
      createdAt: now,
    });
    await ctx.db.patch(goal._id, { progress: args.progress, updatedAt: now });
    return await ctx.db.get(goal._id);
  },
});

export const get = query({
  args: { goalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("goals")
      .withIndex("by_goal_id", (q) => q.eq("goalId", args.goalId))
      .unique();
  },
});

export const list = query({
  args: { conversationId: v.string(), status: v.optional(status) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("goals")
      .withIndex("by_conversation_id_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", args.status ?? "active"),
      )
      .take(50);
  },
});

/** Every conversation's goals, newest first, for the debug dashboard. */
export const listForDashboard = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("goals").order("desc").take(200);
  },
});

export const recentUpdates = query({
  args: { goalId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("goalUpdates")
      .withIndex("by_goal_id", (q) => q.eq("goalId", args.goalId))
      .order("desc")
      .take(args.limit ?? 10);
    return rows.reverse();
  },
});
