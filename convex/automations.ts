import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  DEMO_SCAN_LIMIT,
  isDemoAutomationRun,
  isDemoId,
  isDemoModeEnabled,
} from "./demoMode";

export const create = mutation({
  args: {
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    scheduleKind: v.optional(
      v.union(
        v.literal("cron"),
        v.literal("once"),
        v.literal("interval"),
        v.literal("calendar"),
      ),
    ),
    delivery: v.optional(v.union(v.literal("agent"), v.literal("reminder"), v.literal("checkin"), v.literal("lookahead"))),
    reminderText: v.optional(v.string()),
    goalId: v.optional(v.string()),
    intervalMs: v.optional(v.number()),
    intervalDays: v.optional(v.number()),
    anchorAt: v.optional(v.number()),
    timezone: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    nextRunAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (
      args.scheduleKind === "once" &&
      (!args.nextRunAt || args.nextRunAt <= Date.now())
    )
      throw new Error("One-time reminders require a future time.");
    if (
      args.scheduleKind === "interval" &&
      (!args.intervalMs ||
        args.intervalMs < 60000 ||
        args.anchorAt === undefined)
    )
      throw new Error("Invalid interval schedule.");
    if (
      args.scheduleKind === "calendar" &&
      (!args.intervalDays ||
        !Number.isInteger(args.intervalDays) ||
        args.intervalDays < 1 ||
        !args.timezone ||
        args.anchorAt === undefined)
    )
      throw new Error("Invalid calendar interval.");
    if (
      args.delivery === "reminder" &&
      (!args.reminderText?.trim() || !args.notifyConversationId)
    )
      throw new Error("Reminders require text and a destination conversation.");
    const existing = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("automations", {
      ...args,
      enabled: true,
      createdAt: Date.now(),
    });
  },
});

async function readAutomations(
  ctx: QueryCtx,
  enabledOnly: boolean | undefined,
  demoOnly: boolean,
) {
  const rows = enabledOnly
    ? await ctx.db
        .query("automations")
        .withIndex("by_enabled", (q) => q.eq("enabled", true))
        .order("desc")
        .take(DEMO_SCAN_LIMIT)
    : await ctx.db.query("automations").order("desc").take(DEMO_SCAN_LIMIT);
  return rows.filter(
    (automation) => isDemoId(automation.automationId) === demoOnly,
  );
}

export const list = query({
  args: { enabledOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => readAutomations(ctx, args.enabledOnly, false),
});

export const listForDashboard = query({
  args: { enabledOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    return readAutomations(ctx, args.enabledOnly, await isDemoModeEnabled(ctx));
  },
});

export const get = query({
  args: { automationId: v.string() },
  handler: async (ctx, args) => {
    if (isDemoId(args.automationId)) return null;
    return await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
  },
});

export const getForDashboard = query({
  args: { automationId: v.string() },
  handler: async (ctx, args) => {
    if (isDemoId(args.automationId) !== (await isDemoModeEnabled(ctx)))
      return null;
    return await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
  },
});

export const setEnabled = mutation({
  args: { automationId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (!auto) return null;
    if (
      args.enabled &&
      auto.scheduleKind === "once" &&
      auto.completedAt !== undefined
    )
      throw new Error(
        "This one-time reminder is complete. Reschedule it to run again.",
      );
    await ctx.db.patch(auto._id, { enabled: args.enabled });
    return auto._id;
  },
});

export const remove = mutation({
  args: { automationId: v.string() },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (!auto) return null;
    await ctx.db.delete(auto._id);
    return auto._id;
  },
});

export const markRan = mutation({
  args: {
    automationId: v.string(),
    lastRunAt: v.number(),
    nextRunAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (!auto) return null;
    await ctx.db.patch(auto._id, {
      lastRunAt: args.lastRunAt,
      nextRunAt: args.nextRunAt,
    });
    return auto._id;
  },
});

export const createRun = mutation({
  args: {
    runId: v.string(),
    automationId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("automationRuns", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const updateRun = mutation({
  args: {
    runId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run) return null;
    const completed = args.status !== "running";
    const { runId: _runId, ...patch } = args;
    await ctx.db.patch(run._id, {
      ...patch,
      ...(completed ? { completedAt: Date.now() } : {}),
    });
    return run._id;
  },
});

export const recentRuns = query({
  args: { automationId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    if (args.automationId && isDemoId(args.automationId)) return [];
    if (args.automationId) {
      return (
        await ctx.db
          .query("automationRuns")
          .withIndex("by_automation", (q) =>
            q.eq("automationId", args.automationId!),
          )
          .order("desc")
          .take(DEMO_SCAN_LIMIT)
      )
        .filter((run) => !isDemoAutomationRun(run))
        .slice(0, limit);
    }
    const rows = await ctx.db
      .query("automationRuns")
      .order("desc")
      .take(DEMO_SCAN_LIMIT);
    return rows.filter((run) => !isDemoAutomationRun(run)).slice(0, limit);
  },
});

export const recentRunsForDashboard = query({
  args: { automationId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const demoOnly = await isDemoModeEnabled(ctx);
    if (args.automationId && isDemoId(args.automationId) !== demoOnly)
      return [];
    const rows = args.automationId
      ? await ctx.db
          .query("automationRuns")
          .withIndex("by_automation", (q) =>
            q.eq("automationId", args.automationId!),
          )
          .order("desc")
          .take(DEMO_SCAN_LIMIT)
      : await ctx.db
          .query("automationRuns")
          .order("desc")
          .take(DEMO_SCAN_LIMIT);
    return rows
      .filter((run) => isDemoAutomationRun(run) === demoOnly)
      .slice(0, limit);
  },
});

// The transaction claims a due occurrence before any work starts. The due time
// remains stored until completion, so a crashed server can recover after expiry.
export const claimRun = mutation({
  args: { automationId: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (
      !auto ||
      !auto.enabled ||
      auto.nextRunAt === undefined ||
      auto.nextRunAt > now ||
      (auto.leaseExpiresAt ?? 0) > now
    )
      return null;
    if (auto.leaseRunId) {
      const old = await ctx.db
        .query("automationRuns")
        .withIndex("by_run_id", (q) => q.eq("runId", auto.leaseRunId!))
        .unique();
      if (old?.status === "running")
        await ctx.db.patch(old._id, {
          status: "failed",
          error: "Execution lease expired; recovered by scheduler.",
          completedAt: now,
        });
    }
    await ctx.db.patch(auto._id, {
      leaseRunId: args.runId,
      leaseExpiresAt: now + 120000,
    });
    await ctx.db.insert("automationRuns", {
      runId: args.runId,
      automationId: args.automationId,
      status: "running",
      startedAt: now,
    });
    return auto;
  },
});
export const renewClaim = mutation({
  args: { automationId: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (
      !auto?.enabled ||
      auto.leaseRunId !== args.runId ||
      (auto.leaseExpiresAt ?? 0) <= Date.now()
    )
      return false;
    await ctx.db.patch(auto._id, { leaseExpiresAt: Date.now() + 120000 });
    return true;
  },
});
export const finishRun = mutation({
  args: {
    automationId: v.string(),
    runId: v.string(),
    success: v.boolean(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
    nextRunAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (!auto || auto.leaseRunId !== args.runId) {
      if (run?.status === "running")
        await ctx.db.patch(run._id, {
          status: "failed",
          error: "Reminder cancelled or execution lease lost.",
          completedAt: now,
        });
      return false;
    }
    if (run)
      await ctx.db.patch(run._id, {
        status: args.success ? "completed" : "failed",
        result: args.result,
        error: args.error,
        agentId: args.agentId,
        completedAt: now,
      });
    const failures = args.success ? 0 : (auto.failureCount ?? 0) + 1;
    const retry = auto.scheduleKind === "once" && !args.success && failures < 3;
    const done = auto.scheduleKind === "once" && !retry;
    await ctx.db.patch(auto._id, {
      leaseRunId: undefined,
      leaseExpiresAt: undefined,
      lastRunAt: now,
      failureCount: failures,
      lastError: args.success ? undefined : args.error,
      nextRunAt: retry ? now + 60000 : done ? undefined : args.nextRunAt,
      ...(done
        ? { enabled: false, ...(args.success ? { completedAt: now } : {}) }
        : {}),
    });
    return true;
  },
});

export const reschedule = mutation({
  args: {
    automationId: v.string(),
    conversationId: v.string(),
    schedule: v.string(),
    scheduleKind: v.union(
      v.literal("cron"),
      v.literal("once"),
      v.literal("interval"),
      v.literal("calendar"),
    ),
    nextRunAt: v.number(),
    timezone: v.optional(v.string()),
    intervalMs: v.optional(v.number()),
    intervalDays: v.optional(v.number()),
    anchorAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) =>
        q.eq("automationId", args.automationId),
      )
      .unique();
    if (!auto || auto.conversationId !== args.conversationId) return null;
    if ((auto.leaseExpiresAt ?? 0) > Date.now())
      throw new Error(
        "This reminder is currently running; retry after it finishes.",
      );
    if (args.nextRunAt <= Date.now())
      throw new Error("Choose a future reminder time.");
    const {
      automationId: _id,
      conversationId: _conversationId,
      ...schedule
    } = args;
    await ctx.db.patch(auto._id, {
      ...schedule,
      intervalMs: args.intervalMs,
      intervalDays: args.intervalDays,
      anchorAt: args.anchorAt,
      timezone: args.timezone,
      enabled: true,
      completedAt: undefined,
      lastError: undefined,
      failureCount: 0,
      leaseRunId: undefined,
      leaseExpiresAt: undefined,
    });
    return auto._id;
  },
});

export const due = query({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("automations")
      .withIndex("by_enabled_and_next_run_at", (q) =>
        q.eq("enabled", true).gt("nextRunAt", 0).lte("nextRunAt", args.now),
      )
      .take(200);
    return rows.filter(
      (row) =>
        !isDemoId(row.automationId) && (row.leaseExpiresAt ?? 0) <= args.now,
    );
  },
});
