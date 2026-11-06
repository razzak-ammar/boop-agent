import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Explicit saves are source records, independent of lossy/decaying memory.
  savedCollections: defineTable({
    name: v.string(),
    key: v.string(),
    createdAt: v.number(),
  }).index("by_key", ["key"]),

  savedItems: defineTable({
    collectionId: v.id("savedCollections"),
    title: v.string(),
    content: v.string(),
    searchText: v.string(),
    kind: v.union(v.literal("note"), v.literal("link"), v.literal("image")),
    status: v.string(),
    recommendedBy: v.optional(v.string()),
    urls: v.array(v.string()),
    imageStorageIds: v.array(v.id("_storage")),
    sourceConversationId: v.string(),
    sourceKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collectionId", ["collectionId"])
    .index("by_collectionId_and_status", ["collectionId", "status"])
    .index("by_status", ["status"])
    .index("by_sourceKey", ["sourceKey"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["collectionId", "status"],
    }),

  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_turn", ["conversationId", "turnId"])
    .index("by_createdAt", ["createdAt"]),

  conversations: defineTable({
    conversationId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    messageCount: v.number(),
    lastActivityAt: v.number(),
  }).index("by_conversation", ["conversationId"]),

  memoryRecords: defineTable({
    memoryId: v.string(),
    content: v.string(),
    tier: v.union(v.literal("short"), v.literal("long"), v.literal("permanent")),
    segment: v.union(
      v.literal("identity"),
      v.literal("preference"),
      v.literal("correction"),
      v.literal("relationship"),
      v.literal("project"),
      v.literal("knowledge"),
      v.literal("context"),
    ),
    importance: v.number(),
    decayRate: v.number(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    sourceTurn: v.optional(v.string()),
    lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pruned")),
    supersedes: v.optional(v.array(v.string())),
    embedding: v.optional(v.array(v.float64())),
    // Structured sidecar data (JSON blob). Currently used to carry
    // `corrects` text on correction-segment memories. Intentionally loose
    // so extraction prompts can stash provider-specific hints without
    // schema churn.
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
  })
    .index("by_memory_id", ["memoryId"])
    .index("by_tier", ["tier"])
    .index("by_segment", ["segment"])
    .index("by_lifecycle", ["lifecycle"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["lifecycle"],
    }),

  executionAgents: defineTable({
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    status: v.union(
      v.literal("spawned"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("paused"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    mcpServers: v.array(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_agent_id", ["agentId"])
    .index("by_status", ["status"])
    .index("by_conversation", ["conversationId"]),

  // Append-only LLM usage log. Every model call (dispatcher, execution,
  // extract, consolidation) writes a row here so you can query total cost
  // by source, conversation, or time range.
  usageRecords: defineTable({
    source: v.union(
      v.literal("dispatcher"),
      v.literal("execution"),
      v.literal("extract"),
      v.literal("consolidation-proposer"),
      v.literal("consolidation-adversary"),
      v.literal("consolidation-judge"),
      v.literal("proactive"),
    ),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    runId: v.optional(v.string()),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"]),

  agentLogs: defineTable({
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    // Composio account aliases targeted by this tool call (e.g. ["gmail_charry-fusc"]).
    // Populated when the input names a specific connected account, so multi-account
    // toolkits make it visible which inbox / workspace was actually hit.
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  memoryEvents: defineTable({
    eventType: v.string(),
    conversationId: v.optional(v.string()),
    memoryId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    data: v.string(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_type", ["eventType"]),

  automations: defineTable({
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    scheduleKind: v.optional(v.union(v.literal("cron"), v.literal("once"), v.literal("interval"), v.literal("calendar"))),
    delivery: v.optional(v.union(v.literal("agent"), v.literal("reminder"), v.literal("checkin"), v.literal("lookahead"))),
    reminderText: v.optional(v.string()),
    // Goal check-ins: the goal to check on. Absent on a "checkin" delivery
    // means a daily plan across every active goal.
    goalId: v.optional(v.string()),
    intervalMs: v.optional(v.number()),
    intervalDays: v.optional(v.number()),
    anchorAt: v.optional(v.number()),
    leaseRunId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    failureCount: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    // IANA timezone the cron expression is evaluated in. Stored at create
    // time so changing the user's global timezone later doesn't shift
    // existing automations. Optional for backwards compatibility — pre-TZ
    // automations fall back to the user's current setting at run time.
    timezone: v.optional(v.string()),
    enabled: v.boolean(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"])
    .index("by_enabled_and_next_run_at", ["enabled", "nextRunAt"]),

  // Deadlines the user is working toward (an exam, a project), with dated
  // milestones. Progress is a number in the goal's unit so check-ins can
  // compute pacing instead of the model guessing it.
  goals: defineTable({
    goalId: v.string(),
    conversationId: v.string(),
    title: v.string(),
    // Local calendar date YYYY-MM-DD in the user's timezone.
    deadline: v.string(),
    unit: v.optional(v.string()),
    total: v.optional(v.number()),
    progress: v.number(),
    milestones: v.array(v.object({
      date: v.string(),
      label: v.string(),
      target: v.optional(v.number()),
    })),
    notes: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("done"), v.literal("dropped")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_goal_id", ["goalId"])
    .index("by_conversation_id_and_status", ["conversationId", "status"]),

  goalUpdates: defineTable({
    goalId: v.string(),
    progress: v.number(),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_goal_id", ["goalId"]),

  // Things the user must get done that don't fit a fixed reminder: "sometime
  // the week after my flight back", "study for the exam, date unknown". The
  // daily lookahead sweep nudges them on a cadence until they're done.
  tasks: defineTable({
    taskId: v.string(),
    conversationId: v.string(),
    title: v.string(),
    notes: v.optional(v.string()),
    // Local YYYY-MM-DD window. Both absent = undated (keep asking).
    earliest: v.optional(v.string()),
    latest: v.optional(v.string()),
    // When the window is tied to a calendar event, the sweep re-reads that
    // event and shifts the window if the event moves.
    anchor: v.optional(v.object({
      eventId: v.string(),
      calendarId: v.string(),
      title: v.string(),
      // Local date of the event start (or end, for relation "after").
      date: v.string(),
      relation: v.union(v.literal("before"), v.literal("after")),
      // Window is [date, date + days] for "after", [date - days, date] for "before".
      days: v.number(),
    })),
    // Undated tasks: what's still unknown, e.g. "exam date".
    waitingOn: v.optional(v.string()),
    importance: v.union(v.literal("normal"), v.literal("high")),
    // Days between nudges while the task is actionable.
    cadenceDays: v.number(),
    // "Remind me every hour until...": overrides cadenceDays when set.
    cadenceHours: v.optional(v.number()),
    // Local "HH:mm" deadline on the latest day ("before 8pm").
    dueTime: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("done"), v.literal("dropped")),
    snoozedUntil: v.optional(v.string()),
    lastNudgedAt: v.optional(v.number()),
    nudgeCount: v.number(),
    lastUpdateAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task_id", ["taskId"])
    .index("by_conversation_id_and_status", ["conversationId", "status"]),

  taskUpdates: defineTable({
    taskId: v.string(),
    note: v.string(),
    createdAt: v.number(),
  }).index("by_task_id", ["taskId"]),

  // Calendar events the lookahead sweep has already asked about, so it
  // doesn't ask "anything to prep for your flight?" every morning.
  lookaheadSeen: defineTable({
    conversationId: v.string(),
    eventKey: v.string(),
    askedAt: v.number(),
  }).index("by_conversation_id_and_event_key", ["conversationId", "eventKey"]),

  sendblueDedup: defineTable({
    handle: v.string(),
    claimedAt: v.number(),
  }).index("by_handle", ["handle"]),

  drafts: defineTable({
    draftId: v.string(),
    conversationId: v.string(),
    kind: v.string(),
    summary: v.string(),
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_draft_id", ["draftId"])
    .index("by_conversation_status", ["conversationId", "status"]),

  consolidationRuns: defineTable({
    runId: v.string(),
    trigger: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    proposalsCount: v.number(),
    mergedCount: v.number(),
    prunedCount: v.number(),
    notes: v.optional(v.string()),
    // JSON blob: { proposals: [...], decisions: [...], applied: [...] }
    // Captured so you can inspect the reasoning for any historical run.
    details: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_id", ["runId"])
    .index("by_status", ["status"]),

  // Runtime overrides for things normally pinned by env vars (e.g. the Claude
  // model). Lets the user say "use opus" via iMessage and have the next agent
  // run respect it without a redeploy.
  settings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  automationRuns: defineTable({
    runId: v.string(),
    automationId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_automation", ["automationId"])
    .index("by_run_id", ["runId"]),
});
