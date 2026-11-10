// Gives the interaction agent its open tasks and upcoming reminders up front,
// like goals/context.ts does for goals. Without them, "I need to make those
// poster edits" looks like a brand-new thing unless the model happens to call
// list_tasks, so it creates duplicates and asks for dates it already has.

import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { describeUserNow } from "../timezone-config.js";
import { taskTiming, type TimingTask } from "./timing.js";
import { PULSE_TASK } from "./tools.js";

const MAX_TASKS = 25;
const MAX_REMINDERS = 15;
const MAX_NOTES_CHARS = 200;
const REMINDER_HORIZON_MS = 7 * 86400000;

export type ContextTask = TimingTask & {
  taskId: string;
  title: string;
  notes?: string;
  waitingOn?: string;
};

export interface ContextReminder {
  automationId: string;
  name: string;
  delivery?: string;
  reminderText?: string;
  goalId?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  enabled?: boolean;
}

export function formatTasksNote(
  tasks: ContextTask[],
  reminders: ContextReminder[],
  opts: { today: string; clock: string; timezone: string; now?: number },
): string {
  const now = opts.now ?? Date.now();
  const parts: string[] = [];
  if (tasks.length) {
    // Soonest deadline first; undated ones after the dated.
    const sorted = [...tasks].sort((a, b) => (a.latest ?? "9999").localeCompare(b.latest ?? "9999"));
    const lines = sorted.slice(0, MAX_TASKS).map((t) => JSON.stringify({
      taskId: t.taskId,
      title: t.title,
      notes: t.notes?.slice(0, MAX_NOTES_CHARS),
      earliest: t.earliest,
      latest: t.latest,
      dueTime: t.dueTime,
      waitingOn: t.waitingOn,
      importance: t.importance === "high" ? "high" : undefined,
      state: taskTiming(t, opts.today, now, opts.clock).state,
    }));
    const omitted = sorted.length - lines.length;
    parts.push(`Open tasks (call list_tasks for history${omitted ? ` and the ${omitted} not shown` : ""}):\n${lines.join("\n")}`);
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const upcoming = reminders
    .filter((r) => r.enabled !== false && r.nextRunAt !== undefined && r.nextRunAt >= now - 3600000 && r.nextRunAt <= now + REMINDER_HORIZON_MS)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)
    .slice(0, MAX_REMINDERS)
    .map((r) => JSON.stringify({
      automationId: r.automationId,
      kind: r.delivery === "checkin" ? (r.goalId ? "goal check-in" : "daily plan") : "reminder",
      text: r.delivery === "reminder" ? r.reminderText ?? r.name : r.name,
      next: fmt.format(r.nextRunAt!),
    }));
  if (upcoming.length) parts.push(`Scheduled reminders and check-ins, next 7 days:\n${upcoming.join("\n")}`);
  // One-off reminders disappear once they fire, but the thing they were about
  // often isn't finished ("send the poster to the advisor" this morning, the
  // poster edits tonight). Keep the last week visible so new mentions link up.
  const recent = reminders
    .filter((r) => r.delivery === "reminder" && r.lastRunAt !== undefined &&
      r.lastRunAt <= now && r.lastRunAt >= now - REMINDER_HORIZON_MS)
    .sort((a, b) => b.lastRunAt! - a.lastRunAt!)
    .slice(0, MAX_REMINDERS)
    .map((r) => JSON.stringify({ text: r.reminderText ?? r.name, sent: fmt.format(r.lastRunAt!) }));
  if (recent.length) parts.push(`Reminders already sent in the last 7 days (the user may still be working on these):\n${recent.join("\n")}`);
  if (!parts.length) return "";
  return `\n\nWhat you're already tracking for the user (current as of this turn). Match what they say against these before creating anything new:\n${parts.join("\n\n")}`;
}

export async function loadTrackedNote(conversationId: string): Promise<string> {
  try {
    const [tasks, automations, tz] = await Promise.all([
      convex.query(api.tasks.list, { conversationId, status: "open" }),
      convex.query(api.automations.list, {}),
      describeUserNow(),
    ]);
    const reminders = automations.filter((a) =>
      (a.notifyConversationId ?? a.conversationId) === conversationId &&
      (a.enabled || a.delivery === "reminder") &&
      (a.delivery === "reminder" || a.delivery === "checkin") &&
      a.task !== PULSE_TASK);
    return formatTasksNote(tasks, reminders, { today: tz.isoDate, clock: tz.clock24, timezone: tz.timezone });
  } catch (err) {
    // Extra context only: the agent can still reach these through list_tasks.
    console.error("[tasks] could not load tracked items for the prompt", err);
    return "";
  }
}
