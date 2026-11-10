// The daily lookahead: one model-written message that nudges open tasks that
// are due, and asks ahead about upcoming calendar events that likely need
// prep or a decision. Code decides WHICH tasks are due (timing.ts) and which
// events were already asked about; the model decides what is worth saying.
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { createCalendarTools, runCalendarSearch } from "../calendar/tools.js";
import type { CalendarMatch } from "../calendar/search.js";
import { listEnabledIntegrations } from "../integrations/registry.js";
import { loadMemoryProfile } from "../memory/profile.js";
import { BARE_CLOCK_RULE } from "../interaction-prompt.js";
import { describeUserNow } from "../timezone-config.js";
import { computePacing } from "../goals/pacing.js";
import { alsoDueBlock, NO_REPEAT_RULE, runProactiveModel, SKIP } from "../goals/checkin.js";
import { addDays, windowFromAnchor } from "./timing.js";
import { getQuietHours } from "../quiet-hours-store.js";
import { describeTask, PULSE_TASK } from "./tools.js";

const HORIZON_DAYS = 10;
const MAX_EVENTS = 40;

export const LOOKAHEAD_SYSTEM = `You are Boop, the user's personal assistant over text chat, writing the ONE proactive daily lookahead message. The user is very busy, their calendar is often behind, and missed obligations have real consequences. Your job is to think ahead for them. The message must be worth reading: specific, warm, short (aim under 700 characters), plain text with light Markdown at most. Cover at most 3 items, most urgent first.

You get: open tasks with server-computed timing (use it; never recompute), active goals (they have their own check-ins; mention one only if it is due within 3 days and not already covered), the next ${HORIZON_DAYS} days of calendar events, recent conversation, and the local time.

Tasks (dueForNudge=true are the ones to raise today):
- Ask ONE easy-to-answer question per task: done yet? / when will you do it? / what's blocking you? / want help?
- last_day or overdue: be direct and say what's at stake if notes give it. Offer a concrete rescue (e.g. "want me to block 30 min at 4pm?").
- undated with waitingOn: ask whether they know it yet ("Do you know when the exam is yet?"). For high-importance undated work, also ask how it's going.
- Offer specific help when it would matter: finding the form/link in email, blocking calendar time, breaking it into steps. You can only offer; the user's reply will make it happen.
- If the conversation already shows the user handled or discussed a task today, don't nag about it.
- If a task has anchorIssue, say so plainly and ask for the new date.

Calendar (only events with alreadyAsked=false):
- Look for things that need preparation or a decision the user may not have thought of: flights and trips (check-in, packing, getting to the airport, offer to check flight status the day before), exams/presentations/deadlines (offer to track a study plan), interviews, appointments, forms, RSVPs, tickets, birthdays (gifts). Skip routine recurring classes and meetings.
- Ask at most 2 calendar questions. Make each answerable in a word or two.
- Name events by title and day; flights by code and route when given.

Hourly tasks (cadenceHours set, e.g. "remind me every hour until I submit it"): keep it to one or two lines, vary the wording from earlier nudges in the conversation, and mention time left before dueTime when there is one ("2 hours left before 8pm"). On "deadline within the hour" make it a clear last call; on "deadline just passed" ask whether it got done.

If nothing is worth saying today, reply exactly ${SKIP}.

${NO_REPEAT_RULE}
${BARE_CLOCK_RULE}
Never claim you changed or checked anything beyond what's supplied. Never expose phone numbers.

After the message, on separate final lines, list what you actually raised so it isn't repeated tomorrow:
NUDGED: <comma-separated taskIds you raised, or none>
ASKED: <comma-separated eventKeys you asked about, or none>`;

interface LookaheadAutomation {
  automationId: string;
  task?: string;
  notifyConversationId?: string;
  conversationId?: string;
}

function localDateOf(event: CalendarMatch, timezone: string): string {
  if (event.allDay) return event.start.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(Date.parse(event.start));
}

/** Pull the NUDGED/ASKED trailer off the model's message. Only ids that were
 * actually supplied are accepted. */
export function parseLookaheadReply(text: string, taskIds: Set<string>, eventKeys: Set<string>) {
  const nudged: string[] = [];
  const asked: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^\**(NUDGED|ASKED)\**\s*:\s*\**\s*(.*)$/i);
    if (!m) { kept.push(line); continue; }
    const ids = m[2].split(",").map((s) => s.trim().replace(/^`|`$/g, "")).filter((s) => s && s.toLowerCase() !== "none");
    const target = m[1].toUpperCase() === "NUDGED" ? nudged : asked;
    const allowed = m[1].toUpperCase() === "NUDGED" ? taskIds : eventKeys;
    target.push(...ids.filter((id) => allowed.has(id)));
  }
  const message = kept.join("\n").trim();
  return { message: !message || message === SKIP ? undefined : message, nudged, asked };
}

/** Follow anchored tasks when their event moved; report when it vanished. */
async function refreshAnchors(tasks: Awaited<ReturnType<typeof listOpen>>, timezone: string) {
  const issues = new Map<string, string>();
  for (const task of tasks) {
    const anchor = task.anchor;
    if (!anchor) continue;
    const found = await runCalendarSearch({
      terms: [anchor.title],
      start: `${addDays(anchor.date, -14)}T00:00`,
      end: `${addDays(anchor.date, 120)}T00:00`,
      limit: 200,
    });
    if (typeof found === "string") continue;
    const event = found.events.find((e) => e.id === anchor.eventId && e.calendarId === anchor.calendarId);
    if (!event) {
      if (found.complete) issues.set(task.taskId, `The calendar event "${anchor.title}" (${anchor.date}) is no longer on the calendar; it may have moved or been cancelled.`);
      continue;
    }
    const date = localDateOf(event, timezone);
    if (date !== anchor.date) {
      const window = windowFromAnchor(date, anchor.relation, anchor.days);
      await convex.mutation(api.tasks.reanchor, { taskId: task.taskId, date, ...window });
    }
  }
  return issues;
}

async function listOpen(conversationId: string) {
  return await convex.query(api.tasks.list, { conversationId, status: "open" });
}

export interface LookaheadResult {
  text?: string;
  nudged?: string[];
  asked?: string[];
  /** Free-time checks: the dashboard log row to mark sent or failed. */
  heartbeatEventId?: string;
}

export async function runLookahead(a: LookaheadAutomation, alsoDue?: string[]): Promise<LookaheadResult> {
  const conversationId = a.notifyConversationId ?? a.conversationId;
  if (!conversationId) throw new Error("Lookahead has no destination conversation.");
  const tz = await describeUserNow();
  // The pulse runs every 15 minutes and only handles hourly/same-day tasks:
  // no calendar scan, no goals, and no model call unless one is due.
  const pulse = a.task === PULSE_TASK;
  const integrations = pulse ? [] : (await listEnabledIntegrations()).map((i) => i.name);
  const hasCalendar = integrations.includes("googlecalendar");

  let tasks = await listOpen(conversationId);
  const anchorIssues = hasCalendar && tz.isExplicit ? await refreshAnchors(tasks, tz.timezone) : new Map<string, string>();
  if (anchorIssues.size || tasks.some((t) => t.anchor)) tasks = await listOpen(conversationId);
  const now = Date.now();
  const quiet = await getQuietHours();
  const taskBlocks = await Promise.all(tasks.map(async (t) => ({
    ...(await describeTask(t, tz.isoDate, now, tz.clock24, quiet)),
    ...(anchorIssues.has(t.taskId) ? { anchorIssue: anchorIssues.get(t.taskId) } : {}),
  })));
  // Upcoming tasks (window not open yet) stay out of the message entirely.
  const relevantTasks = taskBlocks.filter((t) => t.timing.state !== "upcoming" && t.timing.state !== "snoozed"
    && (!pulse || t.cadenceHours !== undefined));

  let events: Array<Record<string, unknown>> = [];
  let calendarNote = hasCalendar ? "" : "Calendar is not connected.";
  if (hasCalendar) {
    const found = await runCalendarSearch({ daysAhead: HORIZON_DAYS, limit: MAX_EVENTS });
    if (typeof found === "string") calendarNote = `Calendar unavailable: ${found}`;
    else {
      const keys = found.events.map((e) => `${e.calendarId}:${e.id}`);
      const seen = new Set(await convex.query(api.tasks.seenEvents, { conversationId, eventKeys: keys }));
      events = found.events.map((e) => ({
        eventKey: `${e.calendarId}:${e.id}`,
        title: e.title,
        when: e.localStart,
        allDay: e.allDay,
        location: e.location,
        calendar: e.calendarName,
        flight: e.flight,
        description: e.description?.slice(0, 160),
        alreadyAsked: seen.has(`${e.calendarId}:${e.id}`),
      }));
      if (!found.complete) calendarNote = "Calendar scan was partial; don't claim nothing else is scheduled.";
    }
  }

  const goals = pulse ? [] : await convex.query(api.goals.list, { conversationId, status: "active" });
  const goalBlocks = goals.map((g) => {
    const p = computePacing(g, tz.isoDate);
    return { title: g.title, deadline: g.deadline, daysToDeadline: p.daysToDeadline, status: p.status, percent: p.percent };
  });

  const dueTasks = relevantTasks.filter((t) => t.timing.dueForNudge || "anchorIssue" in t);
  const freshEvents = events.filter((e) => !e.alreadyAsked);
  if (!dueTasks.length && !freshEvents.length && !goalBlocks.some((g) => g.daysToDeadline >= 0 && g.daysToDeadline <= 3))
    return {};

  const history = await convex.query(api.messages.recent, { conversationId, limit: 20 });
  const prompt = [
    `Current local time: ${tz.now} (${tz.timezone}); today is ${tz.isoDate}.`,
    pulse ? "This is an intraday check-in: raise only the due tasks, in one or two lines. Do not bring up the calendar." : "",
    `Open tasks:\n${relevantTasks.length ? JSON.stringify(relevantTasks, null, 1) : "(none)"}`,
    goalBlocks.length ? `Active goals:\n${JSON.stringify(goalBlocks)}` : "",
    calendarNote,
    events.length ? `Next ${HORIZON_DAYS} days of calendar:\n${JSON.stringify(events, null, 1)}` : "",
    history.length
      ? `Recent conversation (oldest first):\n${history.map((m) => `${m.role.toUpperCase()} [${new Date(m.createdAt).toISOString()}]: ${m.content.slice(0, 600)}`).join("\n")}`
      : "",
    alsoDueBlock(alsoDue),
    `Write the message now (with the NUDGED/ASKED lines), or ${SKIP}.`,
  ].filter(Boolean).join("\n\n");

  const result = await runProactiveModel({
    prompt,
    systemPrompt: LOOKAHEAD_SYSTEM + await loadMemoryProfile(),
    tools: hasCalendar ? createCalendarTools() : [],
    conversationId,
  });
  const parsed = parseLookaheadReply(
    result.text.trim(),
    new Set(relevantTasks.map((t) => t.taskId)),
    new Set(events.map((e) => e.eventKey as string)),
  );
  if (!parsed.message) return {};
  return { text: parsed.message, nudged: parsed.nudged, asked: parsed.asked };
}

/** Call only after the message was delivered, so a failed send is retried
 * tomorrow instead of being counted as a nudge. */
export async function recordLookaheadDelivered(conversationId: string, res: LookaheadResult) {
  if (res.nudged?.length) await convex.mutation(api.tasks.markNudged, { conversationId, taskIds: res.nudged });
  if (res.asked?.length) await convex.mutation(api.tasks.markEventsSeen, { conversationId, eventKeys: res.asked });
}
