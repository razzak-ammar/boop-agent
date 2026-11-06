import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { buildSchedule } from "../reminder-schedule.js";
import { describeUserNow } from "../timezone-config.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { defaultCadence, defaultCadenceHours, taskTiming, windowFromAnchor } from "./timing.js";

const NAMESPACE = "boop-tasks";
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use local YYYY-MM-DD.");
const clock = z.string().regex(/^\d{2}:\d{2}$/, "Use 24-hour HH:mm.");
export const DEFAULT_LOOKAHEAD_TIME = "09:00";
/** Task text marking the frequent pulse that serves hourly tasks. */
export const PULSE_TASK = "Pulse: hourly task check-ins.";
const PULSE_SECONDS = 15 * 60;

const anchorShape = z.object({
  eventId: z.string().describe("Event id from search_calendar_events."),
  calendarId: z.string().describe("calendarId from search_calendar_events."),
  title: z.string().max(200).describe("Event title, used to find it again if it moves."),
  date: localDate.describe("Local date of the event (YYYY-MM-DD)."),
  relation: z.enum(["before", "after"]).describe('"after" for "within a week after my flight back", "before" for "sometime before the trip".'),
  days: z.number().int().min(0).max(90).describe("Window length in days from the event."),
});

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type Task = NonNullable<Awaited<ReturnType<typeof getTask>>>;
async function getTask(taskId: string) {
  return await convex.query(api.tasks.get, { taskId });
}

export async function describeTask(task: Task, today: string, now = Date.now(), localClock?: string) {
  const updates = await convex.query(api.tasks.recentUpdates, { taskId: task.taskId, limit: 5 });
  return {
    taskId: task.taskId,
    title: task.title,
    notes: task.notes,
    window: task.earliest || task.latest ? { earliest: task.earliest, latest: task.latest } : null,
    anchor: task.anchor ? { title: task.anchor.title, date: task.anchor.date, relation: task.anchor.relation, days: task.anchor.days } : undefined,
    waitingOn: task.waitingOn,
    importance: task.importance,
    cadenceDays: task.cadenceDays,
    cadenceHours: task.cadenceHours,
    dueTime: task.dueTime,
    status: task.status,
    snoozedUntil: task.snoozedUntil,
    timing: taskTiming(task, today, now, localClock),
    timesNudged: task.nudgeCount,
    lastNudgedAt: task.lastNudgedAt && new Date(task.lastNudgedAt).toISOString(),
    recentUpdates: updates.map((u) => ({ note: u.note, at: new Date(u.createdAt).toISOString() })),
  };
}

async function findLookahead(conversationId: string) {
  const all = await convex.query(api.automations.list, {});
  return all.find((a) => a.delivery === "lookahead" && a.task !== PULSE_TASK && a.notifyConversationId === conversationId);
}

/** Hourly tasks need a sweep more often than the daily lookahead. It costs
 * only database reads until a task is actually due. */
export async function ensurePulse(conversationId: string) {
  const all = await convex.query(api.automations.list, {});
  const existing = all.find((a) => a.delivery === "lookahead" && a.task === PULSE_TASK && a.notifyConversationId === conversationId);
  if (existing) {
    if (!existing.enabled) await convex.mutation(api.automations.setEnabled, { automationId: existing.automationId, enabled: true });
    return existing.automationId;
  }
  const automationId = id("auto");
  await convex.mutation(api.automations.create, {
    automationId,
    name: "Task pulse",
    task: PULSE_TASK,
    integrations: [],
    ...buildSchedule({ everySeconds: PULSE_SECONDS }, null),
    delivery: "lookahead",
    conversationId,
    notifyConversationId: conversationId,
  });
  return automationId;
}

/** Make sure a daily lookahead sweep exists so tasks actually get nudged. An
 * existing sweep the user turned off stays off. */
export async function ensureLookahead(conversationId: string, time = DEFAULT_LOOKAHEAD_TIME) {
  const existing = await findLookahead(conversationId);
  if (existing) return { automationId: existing.automationId, enabled: existing.enabled, created: false };
  const tz = await describeUserNow();
  if (!tz.isExplicit) return { enabled: false, created: false, needsTimezone: true };
  const [h, m] = time.split(":").map(Number);
  const fields = buildSchedule({ schedule: `${m} ${h} * * *` }, tz.timezone);
  const automationId = id("auto");
  await convex.mutation(api.automations.create, {
    automationId,
    name: "Daily lookahead",
    task: "Review open tasks and the upcoming calendar; nudge and ask ahead.",
    integrations: [],
    ...fields,
    delivery: "lookahead",
    conversationId,
    notifyConversationId: conversationId,
  });
  return { automationId, enabled: true, created: true, time };
}

export function createTaskTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "create_task",
      'Track something the user must get done that has no fixed clock time: "sometime within a week after my flight back, remind me to do the reflection form", "I need to study for the exam but don\'t know when it is", "make sure I renew my license this month". The daily lookahead sweep nudges it on a cadence (and daily near the end) until it is marked done, and asks for missing info. Give a window (earliest/latest) when known; pass anchor instead when the window is relative to a calendar event (search the calendar first) so it follows the event if it moves. With no window, set waitingOn to what is unknown. For "remind me every hour until X" or "sometime today before 8pm", set cadenceHours (and latest=today + dueTime when there is a deadline): it keeps checking in every N hours (skipping 22:00-08:00 unless the deadline is near), gives a last call within the hour of dueTime, and stops once marked done. Not for exact one-off clock reminders (create_reminder) or deadline plans with milestones (create_goal).',
      {
        title: z.string().trim().min(1).max(200).describe("What has to get done, in the user's words."),
        notes: z.string().max(2000).optional().describe("Context worth remembering: why it matters, links, consequences of missing it."),
        earliest: localDate.optional().describe("First day it makes sense to do it."),
        latest: localDate.optional().describe("Last day it can be done."),
        anchor: anchorShape.optional(),
        waitingOn: z.string().max(200).optional().describe('What is still unknown, e.g. "exam date". The sweep asks about it.'),
        importance: z.enum(["normal", "high"]).default("normal").describe('"high" when missing it has real consequences or the user stresses it.'),
        cadenceDays: z.number().int().min(1).max(30).optional().describe("Days between nudges. Default: 2 (dated) or 3 (undated); 1/2 for high importance."),
        cadenceHours: z.number().min(0.5).max(12).optional().describe('Check in every N hours instead of days: "every hour until" → 1. Defaults to 2 (1 if high) for a task due today with dueTime, 3 for "sometime today".'),
        dueTime: clock.optional().describe('Local 24-hour deadline on the latest day, e.g. "20:00" for "before 8pm". Requires latest.'),
      },
      async (args) => {
        try {
          const tz = await describeUserNow();
          if (!tz.isExplicit) return runtimeText("Ask the user for their timezone before tracking tasks.", false);
          const window = args.anchor
            ? windowFromAnchor(args.anchor.date, args.anchor.relation, args.anchor.days)
            : { earliest: args.earliest, latest: args.latest };
          const dated = Boolean(window.earliest || window.latest);
          if (args.dueTime && !window.latest) return runtimeText("dueTime needs latest (the deadline's date).", false);
          const sameDay = window.latest === tz.isoDate;
          const cadenceHours = args.cadenceHours ?? (sameDay ? defaultCadenceHours(args.importance, Boolean(args.dueTime)) : undefined);
          const taskId = id("task");
          await convex.mutation(api.tasks.create, {
            taskId,
            conversationId,
            title: args.title,
            notes: args.notes,
            ...window,
            anchor: args.anchor,
            waitingOn: args.waitingOn,
            importance: args.importance,
            cadenceDays: args.cadenceDays ?? defaultCadence(args.importance, dated),
            cadenceHours,
            dueTime: args.dueTime,
          });
          const lookahead = await ensureLookahead(conversationId);
          if (cadenceHours) await ensurePulse(conversationId);
          const task = (await getTask(taskId))!;
          return runtimeText(JSON.stringify({ saved: true, task: await describeTask(task, tz.isoDate, Date.now(), tz.clock24), lookahead }));
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "list_tasks",
      "List the user's tracked tasks with timing (undated, upcoming, in_window, last_day, overdue, snoozed), days left, what is unknown, and recent updates. Use before answering a nudge reply, planning the day, or saying what's outstanding.",
      { status: z.enum(["open", "done", "dropped"]).default("open") },
      async (args) => {
        const tz = await describeUserNow();
        const tasks = await convex.query(api.tasks.list, { conversationId, status: args.status });
        return runtimeText(JSON.stringify({
          today: tz.isoDate,
          tasks: await Promise.all(tasks.map((t) => describeTask(t, tz.isoDate, Date.now(), tz.clock24))),
        }));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "update_task",
      'Change a task when the user gives an update: mark done/dropped, set or move the window once a date is known ("the exam is Dec 3"), re-anchor to a calendar event, clear waitingOn, change importance or nudge cadence, or snooze ("stop asking until Monday" → snoozedUntil). Send only the fields that change; null clears a field.',
      {
        taskId: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        notes: z.string().max(2000).optional(),
        earliest: localDate.optional(),
        latest: localDate.optional(),
        clearWindow: z.boolean().optional().describe("Make the task undated again."),
        anchor: anchorShape.nullable().optional(),
        waitingOn: z.string().max(200).nullable().optional(),
        importance: z.enum(["normal", "high"]).optional(),
        cadenceDays: z.number().int().min(1).max(30).optional(),
        cadenceHours: z.number().min(0.5).max(12).nullable().optional().describe("Hourly check-ins; null goes back to daily cadence."),
        dueTime: clock.nullable().optional(),
        status: z.enum(["open", "done", "dropped"]).optional(),
        snoozedUntil: localDate.nullable().optional().describe("Local date to resume nudging."),
      },
      async ({ anchor, ...args }) => {
        try {
          const window = anchor ? windowFromAnchor(anchor.date, anchor.relation, anchor.days) : {};
          const task = await convex.mutation(api.tasks.update, { ...args, ...window, anchor, conversationId });
          if (!task) return runtimeText("Task not found.", false);
          if (task.cadenceHours && task.status === "open") await ensurePulse(conversationId);
          const tz = await describeUserNow();
          return runtimeText(JSON.stringify({ saved: true, task: await describeTask(task, tz.isoDate, Date.now(), tz.clock24) }));
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "log_task_update",
      'Record a progress note on a task without finishing it ("started the form", "waiting on my professor", "studied 2 hours"). Resets the nudge clock so the user isn\'t asked again tomorrow.',
      { taskId: z.string(), note: z.string().trim().min(1).max(1000) },
      async (args) => {
        const task = await convex.mutation(api.tasks.logUpdate, { ...args, conversationId });
        if (!task) return runtimeText("Task not found.", false);
        const tz = await describeUserNow();
        return runtimeText(JSON.stringify({ saved: true, task: await describeTask(task, tz.isoDate) }));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "configure_lookahead",
      "Turn the daily lookahead on or off, or change its time. Each day it reviews open tasks and the next ~10 days of calendar, then sends at most one message: nudges, and questions about upcoming events that need prep (flights, exams, appointments). It skips the day when nothing is worth saying.",
      {
        enabled: z.boolean().default(true),
        time: clock.optional().describe("Local 24-hour time, default 09:00."),
      },
      async (args) => {
        try {
          const existing = await findLookahead(conversationId);
          if (!existing) {
            if (!args.enabled) return runtimeText("The lookahead is already off.");
            const created = await ensureLookahead(conversationId, args.time ?? DEFAULT_LOOKAHEAD_TIME);
            if (created.needsTimezone) return runtimeText("Ask the user for their timezone first.", false);
            return runtimeText(`Lookahead on, daily at ${args.time ?? DEFAULT_LOOKAHEAD_TIME}.`);
          }
          if (args.time) {
            const tz = await describeUserNow();
            if (!tz.isExplicit) return runtimeText("Ask the user for their timezone first.", false);
            const [h, m] = args.time.split(":").map(Number);
            const fields = buildSchedule({ schedule: `${m} ${h} * * *` }, tz.timezone);
            await convex.mutation(api.automations.reschedule, {
              automationId: existing.automationId,
              conversationId: existing.conversationId ?? conversationId,
              ...fields,
              scheduleKind: fields.scheduleKind!,
              nextRunAt: fields.nextRunAt!,
            });
          }
          await convex.mutation(api.automations.setEnabled, { automationId: existing.automationId, enabled: args.enabled });
          return runtimeText(args.enabled ? `Lookahead on${args.time ? `, daily at ${args.time}` : ""}.` : "Lookahead off.");
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
  ];
}
