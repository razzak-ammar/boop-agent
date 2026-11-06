import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { scheduleHelp, scheduleShape } from "../automation-tools.js";
import { buildSchedule } from "../reminder-schedule.js";
import { describeUserNow } from "../timezone-config.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { computePacing, defaultCheckinDays } from "./pacing.js";

const NAMESPACE = "boop-goals";
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use local YYYY-MM-DD.");
const milestoneShape = z.object({
  date: localDate,
  label: z.string().trim().min(1).max(200).describe('What should be true by then, e.g. "75% of lectures reviewed".'),
  target: z.number().min(0).optional().describe("Cumulative progress expected by this date, in the goal's unit (9 for 9 of 12 lectures)."),
});
const clock = z.string().regex(/^\d{2}:\d{2}$/, "Use 24-hour HH:mm.");

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type Goal = NonNullable<Awaited<ReturnType<typeof getGoal>>>;
async function getGoal(goalId: string) {
  return await convex.query(api.goals.get, { goalId });
}

async function goalCheckins(goalId: string) {
  const all = await convex.query(api.automations.list, { enabledOnly: true });
  return all.filter((a) => a.delivery === "checkin" && a.goalId === goalId);
}

async function describeGoal(goal: Goal, today: string) {
  const [updates, checkins] = await Promise.all([
    convex.query(api.goals.recentUpdates, { goalId: goal.goalId, limit: 5 }),
    goalCheckins(goal.goalId),
  ]);
  return {
    goalId: goal.goalId,
    title: goal.title,
    deadline: goal.deadline,
    unit: goal.unit,
    total: goal.total,
    milestones: goal.milestones,
    notes: goal.notes,
    status: goal.status,
    pacing: computePacing(goal, today),
    recentUpdates: updates.map((u) => ({ progress: u.progress, note: u.note, at: new Date(u.createdAt).toISOString() })),
    scheduledCheckins: checkins.map((a) => ({ automationId: a.automationId, nextRunAt: a.nextRunAt && new Date(a.nextRunAt).toISOString(), schedule: a.schedule })),
  };
}

async function saveCheckin(opts: {
  conversationId: string;
  goalId?: string;
  name: string;
  task: string;
  fields: ReturnType<typeof buildSchedule>;
}) {
  const automationId = id("auto");
  await convex.mutation(api.automations.create, {
    automationId,
    name: opts.name,
    task: opts.task,
    integrations: [],
    ...opts.fields,
    delivery: "checkin",
    goalId: opts.goalId,
    conversationId: opts.conversationId,
    notifyConversationId: opts.conversationId,
  });
  return automationId;
}

function when(fields: ReturnType<typeof buildSchedule>) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: fields.timezone ?? "UTC",
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(fields.nextRunAt!);
}

export function createGoalTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "create_goal",
      "Track a deadline the user is working toward (exam, project, application) with dated milestones. Model progress as a count when possible (unit + total, e.g. 12 lectures) so check-ins can compute pacing. Schedules model-written check-ins: by default the evening before each milestone and the deadline. Does not create calendar events.",
      {
        title: z.string().trim().min(1).max(200),
        deadline: localDate.describe("Local date of the exam/due date."),
        unit: z.string().trim().max(50).optional().describe('Progress unit, e.g. "lectures", "chapters", "problems".'),
        total: z.number().positive().optional().describe("Total units needed for 100%."),
        progress: z.number().min(0).optional().describe("Units already done."),
        milestones: z.array(milestoneShape).max(30).default([]),
        notes: z.string().max(2000).optional().describe("Plan details worth remembering, e.g. front-load, no review the last 2 days."),
        checkins: z.enum(["milestones", "daily", "none"]).default("milestones"),
        checkinTime: clock.default("18:00").describe("Local time for check-ins."),
      },
      async (args) => {
        try {
          const tz = await describeUserNow();
          if (!tz.isExplicit && args.checkins !== "none")
            return runtimeText("Ask the user for their timezone before scheduling check-ins.", false);
          const goalId = id("goal");
          await convex.mutation(api.goals.create, {
            goalId,
            conversationId,
            title: args.title,
            deadline: args.deadline,
            unit: args.unit,
            total: args.total,
            progress: args.progress,
            milestones: args.milestones,
            notes: args.notes,
          });
          const scheduled: string[] = [];
          const name = `Check-in: ${args.title}`.slice(0, 120);
          const task = `Check in on goal ${goalId}.`;
          if (args.checkins === "milestones") {
            for (const day of defaultCheckinDays(args, tz.isoDate)) {
              try {
                const fields = buildSchedule({ localTime: args.checkinTime, day }, tz.timezone);
                await saveCheckin({ conversationId, goalId, name, task, fields });
                scheduled.push(when(fields));
              } catch {
                // Tonight's slot may already have passed; later ones still apply.
              }
            }
          } else if (args.checkins === "daily") {
            const [h, m] = args.checkinTime.split(":").map(Number);
            const fields = buildSchedule({ schedule: `${m} ${h} * * *` }, tz.timezone);
            await saveCheckin({ conversationId, goalId, name, task, fields });
            scheduled.push(`daily at ${args.checkinTime}`);
          }
          const goal = (await getGoal(goalId))!;
          return runtimeText(JSON.stringify({
            saved: true,
            goal: await describeGoal(goal, tz.isoDate),
            checkinsScheduled: scheduled,
          }));
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "list_goals",
      "List the user's goals with computed pacing (days left, next milestone, remaining units, per-day rate needed, missed milestones), recent progress updates and scheduled check-ins. Use before planning the user's day, answering what's due, or logging progress.",
      { status: z.enum(["active", "done", "dropped"]).default("active") },
      async (args) => {
        const tz = await describeUserNow();
        const goals = await convex.query(api.goals.list, { conversationId, status: args.status });
        return runtimeText(JSON.stringify({
          today: tz.isoDate,
          goals: await Promise.all(goals.map((g) => describeGoal(g, tz.isoDate))),
        }));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "log_goal_progress",
      "Record where the user is on a goal, e.g. after they answer a check-in. progress is the CUMULATIVE total done (\"finished 2 more\" after 4 → 6), not a delta. Returns updated pacing to base advice on.",
      {
        goalId: z.string(),
        progress: z.number().min(0),
        note: z.string().max(1000).optional().describe("Anything useful the user said, e.g. which lectures or what was hard."),
      },
      async (args) => {
        const goal = await convex.mutation(api.goals.logProgress, { ...args, conversationId });
        if (!goal) return runtimeText("Goal not found.", false);
        const tz = await describeUserNow();
        return runtimeText(JSON.stringify({ saved: true, goal: await describeGoal(goal, tz.isoDate) }));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "update_goal",
      "Change a goal: rename, move the deadline, replace milestones (send the full new list), set unit/total, update notes, or mark it done/dropped. Marking done or dropped cancels its scheduled check-ins. Changing milestones does not move existing check-ins; use schedule_checkin if needed.",
      {
        goalId: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        deadline: localDate.optional(),
        unit: z.string().trim().max(50).optional(),
        total: z.number().positive().optional(),
        milestones: z.array(milestoneShape).max(30).optional(),
        notes: z.string().max(2000).optional(),
        status: z.enum(["active", "done", "dropped"]).optional(),
      },
      async (args) => {
        try {
          const goal = await convex.mutation(api.goals.update, { ...args, conversationId });
          if (!goal) return runtimeText("Goal not found.", false);
          let cancelled = 0;
          if (goal.status !== "active") {
            for (const a of await goalCheckins(goal.goalId)) {
              await convex.mutation(api.automations.setEnabled, { automationId: a.automationId, enabled: false });
              cancelled++;
            }
          }
          const tz = await describeUserNow();
          return runtimeText(JSON.stringify({ saved: true, goal: await describeGoal(goal, tz.isoDate), checkinsCancelled: cancelled }));
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "schedule_checkin",
      `Schedule a model-written check-in. With goalId, it checks progress on that goal at the requested time ("check in at 6pm Friday on the 75%"). Without goalId, it is a daily plan: the model reviews today's calendar and all active goals and texts a suggested plan for the day ("plan my day every morning at 8"). Prefer this over create_reminder for anything about a tracked goal. ${scheduleHelp}`,
      {
        goalId: z.string().optional(),
        name: z.string().max(120).optional(),
        focus: z.string().max(500).optional().describe("What the user wants checked or emphasized, in their words."),
        ...scheduleShape,
      },
      async ({ goalId, name, focus, ...schedule }) => {
        try {
          const tz = await describeUserNow();
          const goal = goalId ? await getGoal(goalId) : null;
          if (goalId && (!goal || goal.conversationId !== conversationId))
            return runtimeText("Goal not found.", false);
          const fields = buildSchedule(schedule, tz.isExplicit ? tz.timezone : null);
          const label = name?.trim() || (goal ? `Check-in: ${goal.title}` : "Daily plan");
          const automationId = await saveCheckin({
            conversationId,
            goalId,
            name: label,
            task: focus?.trim() || (goal ? `Check in on goal ${goal.goalId}.` : "Plan the user's day."),
            fields,
          });
          return runtimeText(`Saved ${automationId} "${label}" for ${when(fields)}${fields.scheduleKind === "once" ? "" : " (recurring)"}.`);
        } catch (err) {
          return runtimeText(String(err), false);
        }
      },
    ),
  ];
}
