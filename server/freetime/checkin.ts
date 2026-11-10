// Free-time check-ins: "you're free until 8 and the problem set is due
// Thursday, what are you up to?" The automation ticks every few minutes; the
// gate (gate.ts) decides in code whether to wake the model, and the model
// decides whether a message is worth sending.
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { runCalendarSearch } from "../calendar/tools.js";
import type { CalendarMatch } from "../calendar/search.js";
import { listEnabledIntegrations } from "../integrations/registry.js";
import { loadMemoryProfile } from "../memory/profile.js";
import { BARE_CLOCK_RULE } from "../interaction-prompt.js";
import { describeUserNow } from "../timezone-config.js";
import { computePacing } from "../goals/pacing.js";
import { alsoDueBlock, NO_REPEAT_RULE, runProactiveModel, SKIP } from "../goals/checkin.js";
import { addDays, taskTiming } from "../tasks/timing.js";
import { describeTask } from "../tasks/tools.js";
import { parseLookaheadReply, type LookaheadResult } from "../tasks/lookahead.js";
import { decideFreeTime, endKey, FREE_TIME, type BusyEvent, type FreeTimeDecision } from "./gate.js";
import { getQuietHours } from "../quiet-hours-store.js";
import { describeQuietHours, inQuietHours, type QuietHours } from "../quiet-hours.js";

/** The calendar is read through Composio; ticks reuse a recent read. */
const CALENDAR_CACHE_MS = 10 * 60000;
const DEFAULT_CODEX_MODEL = "gpt-6.1-terra";

export const FREETIME_SYSTEM = `You are Boop, the user's personal assistant over text chat. You and the user work together on keeping their days on track. The server wakes you in the background at moments when they might have time: right after one of their calendar events ends, or about once an hour while they're free. Each time, it hands you their free window, today's calendar, their open tasks and goals, and the recent conversation. You decide one thing: send ONE short message now, or reply exactly ${SKIP}.

${SKIP} is the normal outcome. Write only when they have a real free window AND something on their list fits it.

A good message:
- reads like a text from a friend who knows their schedule: one or two sentences, plain text, no greeting fluff or emoji spam.
- names the free window and the ONE thing that fits it best (closest deadline, or what's behind on pacing).
- ends with an easy question they can answer in a few words ("what are you up to?", "want to start on it?").
Good: "You're free until 8 and the chem problem set is due Thursday. Want to knock out a chunk now?"
Bad: "Hey! Just checking in on your productivity today! 😊"

Read the conversation before writing:
- If they're already working on it, said "not now", or didn't answer your last check-in, reply ${SKIP} unless something changed (a deadline got closer, a bigger window opened).
- If they told you how they like to be nudged, follow it.
- Never guilt-trip.

Don't mention the server, wake-ups or this check. Don't invent tasks or events. Never claim you changed or checked anything beyond what's supplied; you can only suggest.

${NO_REPEAT_RULE}
${BARE_CLOCK_RULE}
Never expose phone numbers.

After the message, on a final separate line, list the tasks you raised so they count as nudged:
NUDGED: <comma-separated taskIds, or none>`;

interface FreeTimeAutomation {
  automationId: string;
  notifyConversationId?: string;
  conversationId?: string;
}

const lastCheckKey = (conversationId: string) => `freetime_last_check:${conversationId}`;

const calendarCache = new Map<string, { at: number; events: CalendarMatch[] }>();

async function todaysEvents(isoDate: string): Promise<CalendarMatch[] | string> {
  const hit = calendarCache.get(isoDate);
  if (hit && Date.now() - hit.at < CALENDAR_CACHE_MS) return hit.events;
  const found = await runCalendarSearch({ start: `${isoDate}T00:00`, end: `${addDays(isoDate, 1)}T00:00`, limit: 200 });
  if (typeof found === "string") return found;
  calendarCache.clear();
  calendarCache.set(isoDate, { at: Date.now(), events: found.events });
  return found.events;
}

/** Calendars whose events mean "I'm busy" (dashboard Settings → Free-time
 * check-ins). Others, like a lab's shared availability calendar, don't count
 * for timing and stay out of the prompt. Unset or empty means all count. */
export const BUSY_CALENDARS_KEY = "freetime_busy_calendars";

export function parseBusyCalendars(raw: string | null | undefined): Set<string> | null {
  if (!raw) return null;
  try {
    const names = JSON.parse(raw);
    if (!Array.isArray(names)) return null;
    const set = new Set(names.filter((n): n is string => typeof n === "string").map((n) => n.trim().toLowerCase()).filter(Boolean));
    return set.size ? set : null;
  } catch {
    return null;
  }
}

const countsAsBusy = (e: CalendarMatch, busy: Set<string> | null) => !busy || busy.has(e.calendarName.trim().toLowerCase());

export function busyEvents(events: CalendarMatch[], busyCalendars: Set<string> | null): BusyEvent[] {
  const busy: BusyEvent[] = [];
  for (const e of events) {
    if (e.allDay || !e.end || !countsAsBusy(e, busyCalendars)) continue;
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start)
      busy.push({ key: `${e.calendarId}:${e.id}`, title: e.title, start, end });
  }
  return busy;
}

/** The model this check runs on. It's a short judgment call several times a
 * day, so on Codex it defaults to Terra; BOOP_FREETIME_MODEL overrides. */
export function freeTimeModel(): string {
  return process.env.BOOP_FREETIME_MODEL?.trim() || DEFAULT_CODEX_MODEL;
}

function clockIn(timezone: string, ms: number) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(ms);
}

function describeWindow(d: FreeTimeDecision, timezone: string, quiet: QuietHours) {
  if (d.next) return `Free for about ${d.freeMinutes} minutes, until "${d.next.title}" at ${clockIn(timezone, d.next.start)}.`;
  if (!quiet.enabled) return "No more events today.";
  return `No more events today. About ${d.freeMinutes} minutes until quiet hours (${describeQuietHours(quiet)}).`;
}

export async function runFreeTimeCheck(a: FreeTimeAutomation, alsoDue?: string[]): Promise<LookaheadResult> {
  const conversationId = a.notifyConversationId ?? a.conversationId;
  if (!conversationId) throw new Error("Free-time check has no destination conversation.");
  const tz = await describeUserNow();
  if (!tz.isExplicit) return {};
  const integrations = (await listEnabledIntegrations()).map((i) => i.name);
  if (!integrations.includes("googlecalendar")) return {};

  const now = Date.now();
  const [tasks, goals, history, lastCheck, busySetting, quiet] = await Promise.all([
    convex.query(api.tasks.list, { conversationId, status: "open" }),
    convex.query(api.goals.list, { conversationId, status: "active" }),
    convex.query(api.messages.recent, { conversationId, limit: 20 }),
    convex.query(api.settings.get, { key: lastCheckKey(conversationId) }),
    convex.query(api.settings.get, { key: BUSY_CALENDARS_KEY }),
    getQuietHours(),
  ]);
  // Cheapest check first: overnight, nothing else needs reading.
  if (inQuietHours(tz.clock24, quiet)) return {};
  const busyCalendars = parseBusyCalendars(busySetting);
  const workable = tasks.filter((t) => {
    const state = taskTiming(t, tz.isoDate, now, tz.clock24).state;
    return state !== "upcoming" && state !== "snoozed";
  });

  const calendar = await todaysEvents(tz.isoDate);
  if (typeof calendar === "string") {
    console.warn("[freetime] calendar unavailable:", calendar);
    return {};
  }
  const events = busyEvents(calendar, busyCalendars);
  const window = FREE_TIME.endWindowMinutes * 60000;
  const endKeys = events.filter((e) => e.end <= now && now - e.end < window).map(endKey);
  const handled = new Set(endKeys.length
    ? await convex.query(api.tasks.seenEvents, { conversationId, eventKeys: endKeys })
    : []);

  const decision = decideFreeTime({
    now,
    clock: tz.clock24,
    events,
    handled,
    lastMessageAt: history.length ? Math.max(...history.map((m) => m.createdAt)) : undefined,
    lastCheckAt: lastCheck ? Number(lastCheck) : undefined,
    hasWork: workable.length > 0 || goals.length > 0,
    quiet,
  });
  if (decision.markHandled.length)
    await convex.mutation(api.tasks.markEventsSeen, { conversationId, eventKeys: decision.markHandled });
  if (!decision.trigger) return {};

  console.log(`[freetime] waking model: ${decision.trigger} (${decision.reason})`);
  await convex.mutation(api.settings.set, { key: lastCheckKey(conversationId), value: String(now) });

  const taskBlocks = await Promise.all(workable.map((t) => describeTask(t, tz.isoDate, now, tz.clock24, quiet)));
  const goalBlocks = goals.map((g) => {
    const p = computePacing(g, tz.isoDate);
    return { title: g.title, deadline: g.deadline, daysToDeadline: p.daysToDeadline, status: p.status, percent: p.percent, next: p.next };
  });
  // All-day items (due dates, trips) from any calendar are useful context;
  // timed events only from the calendars that mean the user is busy.
  const today = calendar
    .filter((e) => e.allDay || countsAsBusy(e, busyCalendars))
    .map((e) => `- ${e.allDay ? "all day" : `${clockIn(tz.timezone, Date.parse(e.start))}–${e.end ? clockIn(tz.timezone, Date.parse(e.end)) : "?"}`}  ${e.title} [${e.calendarName}]`)
    .join("\n");

  const prompt = [
    `Current local time: ${tz.now} (${tz.timezone}); today is ${tz.isoDate}.`,
    `You were woken because: ${decision.reason}.`,
    describeWindow(decision, tz.timezone, quiet),
    `Today's calendar:\n${today || "(nothing)"}`,
    `Open tasks:\n${taskBlocks.length ? JSON.stringify(taskBlocks, null, 1) : "(none)"}`,
    goalBlocks.length ? `Active goals:\n${JSON.stringify(goalBlocks)}` : "",
    history.length
      ? `Recent conversation (oldest first):\n${history.map((m) => `${m.role.toUpperCase()} [${new Date(m.createdAt).toISOString()}]: ${m.content.slice(0, 600)}`).join("\n")}`
      : "",
    alsoDueBlock(alsoDue),
    `Write the message now (with the NUDGED line), or ${SKIP}.`,
  ].filter(Boolean).join("\n\n");

  const result = await runProactiveModel({
    prompt,
    systemPrompt: FREETIME_SYSTEM + await loadMemoryProfile(),
    tools: [],
    conversationId,
    model: freeTimeModel(),
  });
  const parsed = parseLookaheadReply(result.text.trim(), new Set(workable.map((t) => t.taskId)), new Set());
  if (!parsed.message) {
    console.log("[freetime] model chose to stay quiet");
    return {};
  }
  return { text: parsed.message, nudged: parsed.nudged, asked: [] };
}
