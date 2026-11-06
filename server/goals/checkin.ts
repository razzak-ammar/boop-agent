// Scheduled goal check-ins and daily plans. Unlike plain reminders these run
// the user's configured model with the goal's state, pacing math, today's
// calendar and recent conversation, so the message can judge whether the user
// is on track and suggest what to do next. The user's reply then lands in a
// normal interaction turn, which logs progress with the goal tools.
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { createCalendarTools } from "../calendar/tools.js";
import { listEnabledIntegrations } from "../integrations/registry.js";
import { loadMemoryProfile } from "../memory/profile.js";
import { BARE_CLOCK_RULE } from "../interaction-prompt.js";
import { getRuntimeConfig } from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { describeUserNow } from "../timezone-config.js";
import { computePacing } from "./pacing.js";

export const SKIP = "SKIP";

export const CHECKIN_SYSTEM = `You are Boop, the user's personal assistant over text chat, writing ONE proactive message the user did not just ask for. It must be worth reading: specific, short (aim under 500 characters), warm, plain text with light Markdown at most.

You get the user's goals with server-computed pacing (use those numbers; do not recompute), recent progress updates, recent conversation, and the current local time. Use search_calendar_events when available to see today's (and if useful tomorrow's) actual schedule; never invent events.

Goal check-in (a specific goal is named):
- Say where they should be by the next milestone (target and date) and ask for their current number in the goal's unit, in one easy-to-answer question.
- If recent updates or the conversation already show their progress from today, don't ask again: comment on it and give the next step instead.
- If a milestone was missed or the per-day rate is high, propose one concrete adjustment (catch-up blocks at specific free times today/tomorrow, or moving a milestone) and respect plan notes such as "nothing new in the last 2 days".
- If the goal is done or no longer needs attention, reply exactly ${SKIP}.

Daily plan (no specific goal):
- Look at today's calendar, then suggest an ordered plan for the rest of today: what to work on, roughly how much (from pacing perDay), and where it fits between real events. Name free windows with times.
- Mention anything due in the next 3 days. If there are no goals and nothing notable on the calendar, reply exactly ${SKIP}.

${BARE_CLOCK_RULE}
Never claim you changed anything; you can only suggest. Never expose phone numbers.`;

interface CheckinAutomation {
  automationId: string;
  name: string;
  task: string;
  goalId?: string;
  notifyConversationId?: string;
  conversationId?: string;
}

export interface CheckinResult {
  text?: string;
  // The goal is finished, dropped or deleted; the check-in should stop.
  inactive?: boolean;
}

export async function runGoalCheckin(a: CheckinAutomation): Promise<CheckinResult> {
  const conversationId = a.notifyConversationId ?? a.conversationId;
  if (!conversationId) throw new Error("Check-in has no destination conversation.");
  const tz = await describeUserNow();
  const goal = a.goalId ? await convex.query(api.goals.get, { goalId: a.goalId }) : null;
  if (a.goalId && goal?.status !== "active") return { inactive: true };
  const goals = goal ? [goal] : await convex.query(api.goals.list, { conversationId, status: "active" });

  const goalBlocks = await Promise.all(goals.map(async (g) => {
    const updates = await convex.query(api.goals.recentUpdates, { goalId: g.goalId, limit: 5 });
    return {
      goalId: g.goalId,
      title: g.title,
      deadline: g.deadline,
      unit: g.unit,
      total: g.total,
      milestones: g.milestones,
      notes: g.notes,
      pacing: computePacing(g, tz.isoDate),
      recentUpdates: updates.map((u) => ({ progress: u.progress, note: u.note, at: new Date(u.createdAt).toISOString() })),
    };
  }));
  const history = await convex.query(api.messages.recent, { conversationId, limit: 20 });
  const integrations = (await listEnabledIntegrations()).map((i) => i.name);
  const calendar = integrations.includes("googlecalendar") ? createCalendarTools() : [];

  const prompt = [
    `Current local time: ${tz.now} (${tz.timezone}); today is ${tz.isoDate}.`,
    goal ? `Goal check-in for "${goal.title}".` : "Daily plan.",
    a.task ? `Scheduled request: ${a.task}` : "",
    calendar.length ? "" : "Calendar is not connected; plan without specific event times.",
    `Goals:\n${JSON.stringify(goalBlocks, null, 1)}`,
    history.length
      ? `Recent conversation (oldest first):\n${history.map((m) => `${m.role.toUpperCase()} [${new Date(m.createdAt).toISOString()}]: ${m.content}`).join("\n")}`
      : "",
    `Write the message now, or ${SKIP}.`,
  ].filter(Boolean).join("\n\n");

  const result = await runProactiveModel({ prompt, systemPrompt: CHECKIN_SYSTEM + await loadMemoryProfile(), tools: calendar, conversationId });
  const text = result.text.trim();
  return { text: !text || text === SKIP ? undefined : text };
}

/** One tool-limited model call for a proactive message (check-ins, lookahead),
 * with usage recorded under the "proactive" source. Only calendar reads are
 * allowed; the message can suggest but never change anything. */
export async function runProactiveModel(opts: {
  prompt: string;
  systemPrompt: string;
  tools: ReturnType<typeof createCalendarTools>;
  conversationId: string;
}) {
  const runtimeConfig = await getRuntimeConfig();
  const started = Date.now();
  const result = await runAgentRuntime(runtimeConfig, {
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    mode: "dispatcher",
    allowedTools: opts.tools.length ? ["mcp__boop-calendar__*"] : [],
    disallowedTools: ["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "Skill"],
  });
  if (result.usage.costUsd > 0 || result.usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "proactive",
      conversationId: opts.conversationId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: result.usage.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      costUsd: result.usage.costUsd,
      durationMs: Date.now() - started,
    });
  }
  return result;
}
