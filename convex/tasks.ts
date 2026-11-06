import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const localDate = /^\d{4}-\d{2}-\d{2}$/;
const status = v.union(v.literal("open"), v.literal("done"), v.literal("dropped"));
const importance = v.union(v.literal("normal"), v.literal("high"));
const anchor = v.object({
  eventId: v.string(),
  calendarId: v.string(),
  title: v.string(),
  date: v.string(),
  relation: v.union(v.literal("before"), v.literal("after")),
  days: v.number(),
});

function checkDates(...dates: Array<string | undefined>) {
  if (dates.some((d) => d !== undefined && !localDate.test(d)))
    throw new Error("Task dates must be local YYYY-MM-DD.");
}
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
function checkHourly(cadenceHours?: number | null, dueTime?: string | null) {
  if (cadenceHours != null && (cadenceHours < 0.5 || cadenceHours > 12))
    throw new Error("Hourly cadence must be between 0.5 and 12 hours.");
  if (dueTime != null && !clock.test(dueTime)) throw new Error("dueTime must be 24-hour HH:mm.");
}
function checkWindow(earliest?: string, latest?: string) {
  if (earliest && latest && earliest > latest)
    throw new Error("The task window must start on or before it ends.");
}

async function byTaskId(ctx: MutationCtx, taskId: string) {
  return await ctx.db
    .query("tasks")
    .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
    .unique();
}

export const create = mutation({
  args: {
    taskId: v.string(),
    conversationId: v.string(),
    title: v.string(),
    notes: v.optional(v.string()),
    earliest: v.optional(v.string()),
    latest: v.optional(v.string()),
    anchor: v.optional(anchor),
    waitingOn: v.optional(v.string()),
    importance,
    cadenceDays: v.number(),
    cadenceHours: v.optional(v.number()),
    dueTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    checkDates(args.earliest, args.latest, args.anchor?.date);
    checkHourly(args.cadenceHours, args.dueTime);
    if (args.dueTime && !args.latest) throw new Error("dueTime needs a latest date.");
    checkWindow(args.earliest, args.latest);
    if (!Number.isInteger(args.cadenceDays) || args.cadenceDays < 1 || args.cadenceDays > 30)
      throw new Error("Nudge cadence must be 1-30 days.");
    const existing = await byTaskId(ctx, args.taskId);
    if (existing) return existing;
    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      ...args,
      status: "open",
      nudgeCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const update = mutation({
  args: {
    taskId: v.string(),
    conversationId: v.string(),
    title: v.optional(v.string()),
    notes: v.optional(v.string()),
    earliest: v.optional(v.string()),
    latest: v.optional(v.string()),
    // Explicit null clears; undefined leaves as is.
    clearWindow: v.optional(v.boolean()),
    anchor: v.optional(v.union(anchor, v.null())),
    waitingOn: v.optional(v.union(v.string(), v.null())),
    importance: v.optional(importance),
    cadenceDays: v.optional(v.number()),
    cadenceHours: v.optional(v.union(v.number(), v.null())),
    dueTime: v.optional(v.union(v.string(), v.null())),
    status: v.optional(status),
    snoozedUntil: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { taskId, conversationId, clearWindow, ...fields }) => {
    checkDates(fields.earliest, fields.latest, fields.anchor?.date, fields.snoozedUntil ?? undefined);
    checkHourly(fields.cadenceHours, fields.dueTime);
    if (fields.cadenceDays !== undefined && (!Number.isInteger(fields.cadenceDays) || fields.cadenceDays < 1 || fields.cadenceDays > 30))
      throw new Error("Nudge cadence must be 1-30 days.");
    const task = await byTaskId(ctx, taskId);
    if (!task || task.conversationId !== conversationId) return null;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      patch[key] = value === null ? undefined : value;
    }
    if (clearWindow) {
      patch.earliest = undefined;
      patch.latest = undefined;
      patch.anchor = undefined;
      patch.dueTime = undefined;
    }
    const earliest = "earliest" in patch ? (patch.earliest as string | undefined) : task.earliest;
    const latest = "latest" in patch ? (patch.latest as string | undefined) : task.latest;
    checkWindow(earliest, latest);
    await ctx.db.patch(task._id, patch);
    return await ctx.db.get(task._id);
  },
});

/** A progress note from the user ("submitted half of it", "exam is Dec 3").
 * Counts as contact, so the next nudge waits a full cadence. */
export const logUpdate = mutation({
  args: { taskId: v.string(), conversationId: v.string(), note: v.string() },
  handler: async (ctx, args) => {
    const task = await byTaskId(ctx, args.taskId);
    if (!task || task.conversationId !== args.conversationId) return null;
    const now = Date.now();
    await ctx.db.insert("taskUpdates", { taskId: args.taskId, note: args.note, createdAt: now });
    await ctx.db.patch(task._id, { lastUpdateAt: now, updatedAt: now });
    return await ctx.db.get(task._id);
  },
});

export const markNudged = mutation({
  args: { conversationId: v.string(), taskIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let marked = 0;
    for (const taskId of args.taskIds.slice(0, 50)) {
      const task = await byTaskId(ctx, taskId);
      if (!task || task.conversationId !== args.conversationId) continue;
      await ctx.db.patch(task._id, { lastNudgedAt: now, nudgeCount: task.nudgeCount + 1 });
      marked++;
    }
    return marked;
  },
});

/** Shift an anchored window when its calendar event moved. */
export const reanchor = mutation({
  args: { taskId: v.string(), date: v.string(), earliest: v.string(), latest: v.string() },
  handler: async (ctx, args) => {
    checkDates(args.date, args.earliest, args.latest);
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (!task?.anchor) return null;
    await ctx.db.patch(task._id, {
      anchor: { ...task.anchor, date: args.date },
      earliest: args.earliest,
      latest: args.latest,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(task._id);
  },
});

export const get = query({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
  },
});

export const list = query({
  args: { conversationId: v.string(), status: v.optional(status) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_conversation_id_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", args.status ?? "open"),
      )
      .take(100);
  },
});

export const recentUpdates = query({
  args: { taskId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("taskUpdates")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(args.limit ?? 5);
    return rows.reverse();
  },
});

export const seenEvents = query({
  args: { conversationId: v.string(), eventKeys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const seen: string[] = [];
    for (const eventKey of args.eventKeys.slice(0, 200)) {
      const row = await ctx.db
        .query("lookaheadSeen")
        .withIndex("by_conversation_id_and_event_key", (q) =>
          q.eq("conversationId", args.conversationId).eq("eventKey", eventKey),
        )
        .unique();
      if (row) seen.push(eventKey);
    }
    return seen;
  },
});

export const markEventsSeen = mutation({
  args: { conversationId: v.string(), eventKeys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const eventKey of args.eventKeys.slice(0, 50)) {
      const row = await ctx.db
        .query("lookaheadSeen")
        .withIndex("by_conversation_id_and_event_key", (q) =>
          q.eq("conversationId", args.conversationId).eq("eventKey", eventKey),
        )
        .unique();
      if (row) await ctx.db.patch(row._id, { askedAt: now });
      else await ctx.db.insert("lookaheadSeen", { conversationId: args.conversationId, eventKey, askedAt: now });
    }
  },
});
