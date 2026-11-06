import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { availableIntegrations } from "./execution-agent.js";
import { assertRequestedReminderTime, buildSchedule } from "./reminder-schedule.js";
import { describeUserNow } from "./timezone-config.js";
import { createClaudeMcpServer } from "./runtimes/claude.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
const NAMESPACE = "boop-automations";
export const scheduleShape = {
  localTime: z.string().optional().describe('Local clock HH:mm[:ss] in 24-hour time. PREFERRED for "at 8:30pm", "tonight", "today", or "tomorrow": send localTime="20:30" and day="today" (or "tomorrow"). The application resolves the calendar date.'),
  day: z.string().optional().describe('With localTime: "today" (default), "tomorrow", or exact YYYY-MM-DD. Never substitute the UTC/server calendar date for today.'),
  schedule: z
    .string()
    .optional()
    .describe(
      '5-field cron in the saved LOCAL timezone: weekdays 9am="0 9 * * 1-5", Mon/Wed/Fri="0 9 * * 1,3,5", monthly 1st="0 9 1 * *". Never use day-of-month */N for every N days.',
    ),
  at: z
    .string()
    .optional()
    .describe(
      "Exact YYYY-MM-DDTHH:mm[:ss] in the saved timezone, or ISO timestamp with explicit UTC offset. Alone means once; with an interval sets its first occurrence. Ask about ambiguous dates/times.",
    ),
  afterSeconds: z
    .number()
    .min(1)
    .max(315360000)
    .optional()
    .describe(
      "One-time delay from now, e.g. 1800 for in 30 minutes. No timezone needed.",
    ),
  everySeconds: z
    .number()
    .min(60)
    .max(315360000)
    .optional()
    .describe(
      "Fixed elapsed interval: every 3 hours=10800; every 48 hours=172800. May include at for its first run.",
    ),
  everyDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe(
      "Calendar-day interval in the saved timezone, preserving local clock across DST: every other day=2, every two weeks=14. Use at for the first desired occurrence.",
    ),
};
export const scheduleHelp =
  "Choose exactly one: localTime + day (once, preferred for clock-only requests), at (exact date), afterSeconds (once), schedule (cron), everySeconds (elapsed interval), or everyDays (calendar interval). Intervals may additionally specify at or localTime + day. Ask for a timezone before local wall-clock schedules if unset; relative delays need none. A passed time must not silently move to tomorrow; ask the user. Never invent a time when the user has not specified one.";
function id() {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
async function scheduled(input: Parameters<typeof buildSchedule>[0], requestText: string) {
  const tz = await describeUserNow();
  const now = Date.now();
  const fields = buildSchedule(input, tz.isExplicit ? tz.timezone : null, now);
  if (tz.isExplicit) assertRequestedReminderTime(requestText, fields, tz.timezone, now);
  return fields;
}
function confirmation(
  automationId: string,
  name: string,
  fields: ReturnType<typeof buildSchedule>,
) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: fields.timezone ?? "UTC",
    dateStyle: "full",
    timeStyle: "long",
  }).format(fields.nextRunAt!);
  return `Saved ${automationId} "${name}". ${fields.scheduleKind === "once" ? "One time only" : "Recurring"}; next: ${when}. Schedule: ${fields.schedule}.`;
}
function scheduleReceipt(name: string, fields: ReturnType<typeof buildSchedule>): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: fields.timezone ?? "UTC",
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(fields.nextRunAt!);
  return `Saved "${name}" for ${when}${fields.scheduleKind === "once" ? "" : " (recurring)"}.`;
}

export function createAutomationTools(conversationId: string, requestText = "", onScheduled?: (receipt: string) => void): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "create_reminder",
      `Save a plain reminder to this conversation. It sends the supplied message directly when due, without a model call. ${scheduleHelp}`,
      {
        message: z
          .string()
          .trim()
          .min(1)
          .max(10000)
          .describe(
            'The exact useful reminder text, e.g. "Take the laundry out". Not a request to look something up.',
          ),
        name: z.string().optional(),
        ...scheduleShape,
      },
      async (args) => {
        try {
          const fields = await scheduled(args, requestText);
          const automationId = id();
          const name = args.name?.trim() || args.message.slice(0, 64);
          await convex.mutation(api.automations.create, {
            automationId,
            name,
            task: args.message,
            integrations: [],
            ...fields,
            delivery: "reminder",
            reminderText: args.message,
            conversationId,
            notifyConversationId: conversationId,
          });
          onScheduled?.(scheduleReceipt(name, fields));
          return runtimeText(confirmation(automationId, name, fields));
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "create_automation",
      `Schedule work requiring an agent (calendar summaries, research, integrations). For plain reminders prefer create_reminder. ${scheduleHelp} Available integrations: ${availableIntegrations().join(", ") || "none"}.`,
      {
        name: z.string(),
        task: z.string(),
        ...scheduleShape,
        integrations: z.array(z.string()).optional().default([]),
        notify: z.boolean().optional().default(true),
      },
      async (args) => {
        try {
          const fields = await scheduled(args, requestText);
          const automationId = id();
          await convex.mutation(api.automations.create, {
            automationId,
            name: args.name,
            task: args.task,
            integrations: args.integrations,
            ...fields,
            delivery: "agent",
            conversationId,
            notifyConversationId: args.notify ? conversationId : undefined,
          });
          onScheduled?.(scheduleReceipt(args.name, fields));
          return runtimeText(confirmation(automationId, args.name, fields));
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "list_automations",
      "List reminders and scheduled tasks for this conversation, including completed one-time reminders.",
      { enabledOnly: z.boolean().optional().default(false) },
      async (args) => {
        const all = await convex.query(api.automations.list, {
          enabledOnly: args.enabledOnly,
        });
        return runtimeText(
          JSON.stringify({
            automations: all
              .filter((a) => a.conversationId === conversationId)
              .map((a) => ({
                automationId: a.automationId,
                name: a.name,
                task: a.task,
                enabled: a.enabled,
                scheduleKind: a.scheduleKind ?? "cron",
                schedule: a.schedule,
                timezone: a.timezone,
                nextRunAt: a.nextRunAt,
                completedAt: a.completedAt,
                lastError: a.lastError,
              })),
          }),
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "reschedule_automation",
      `Change when an existing reminder/task runs (also works for a completed one-time reminder). Pass its exact automationId from list_automations. ${scheduleHelp}`,
      { automationId: z.string(), ...scheduleShape },
      async (args) => {
        try {
          const fields = await scheduled(args, requestText);
          const saved = await convex.mutation(api.automations.reschedule, {
            automationId: args.automationId,
            conversationId,
            ...fields,
            scheduleKind: fields.scheduleKind!,
            nextRunAt: fields.nextRunAt!,
          });
          if (saved) onScheduled?.(scheduleReceipt("Rescheduled reminder", fields));
          return runtimeText(
            saved
              ? confirmation(args.automationId, "rescheduled", fields)
              : "Not found.",
            Boolean(saved),
          );
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "toggle_automation",
      "Pause or resume a reminder/task. Completed one-time reminders need rescheduling.",
      { automationId: z.string(), enabled: z.boolean() },
      async (args) => {
        try {
          const saved = await convex.mutation(api.automations.setEnabled, args);
          return runtimeText(
            saved
              ? `Set ${args.automationId} enabled=${args.enabled}.`
              : "Not found.",
            Boolean(saved),
          );
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "delete_automation",
      "Remove a reminder/task.",
      { automationId: z.string() },
      async (args) => {
        const saved = await convex.mutation(api.automations.remove, args);
        return runtimeText(
          saved ? `Deleted ${args.automationId}.` : "Not found.",
          Boolean(saved),
        );
      },
    ),
  ];
}
export function createAutomationMcp(conversationId: string) {
  return createClaudeMcpServer(
    NAMESPACE,
    createAutomationTools(conversationId),
  );
}
