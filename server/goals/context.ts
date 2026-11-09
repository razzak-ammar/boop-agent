// Gives the interaction agent its active goals up front, so a passing mention
// of one doesn't depend on the model thinking to call list_goals.

import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { describeUserNow } from "../timezone-config.js";
import { computePacing, type PacingGoal } from "./pacing.js";

const MAX_GOALS = 20;
const MAX_NOTES_CHARS = 300;

type ContextGoal = PacingGoal & { goalId: string; notes?: string };

export function formatGoalsNote(goals: ContextGoal[], today: string): string {
  if (!goals.length) return "";
  const soonest = [...goals].sort((a, b) => a.deadline.localeCompare(b.deadline));
  const lines = soonest.slice(0, MAX_GOALS).map((goal) => {
    const { daysToDeadline, percent, status, next, missed } = computePacing(goal, today);
    return JSON.stringify({
      goalId: goal.goalId,
      title: goal.title,
      deadline: goal.deadline,
      daysToDeadline,
      progress: goal.progress,
      total: goal.total,
      unit: goal.unit,
      percent,
      status,
      next: next && { date: next.date, label: next.label, target: next.target, remaining: next.remaining, perDay: next.perDay },
      missed: missed.length ? missed.map((m) => m.label) : undefined,
      notes: goal.notes?.slice(0, MAX_NOTES_CHARS),
    });
  });
  const omitted = soonest.length - lines.length;
  return `\n\nActive goals (current as of this turn; pacing is computed, so use it rather than recomputing. Call list_goals for progress history, scheduled check-ins, finished goals${omitted ? `, or the ${omitted} not shown here` : ""}):\n${lines.join("\n")}`;
}

export async function loadActiveGoalsNote(conversationId: string): Promise<string> {
  try {
    const [goals, tz] = await Promise.all([
      convex.query(api.goals.list, { conversationId, status: "active" }),
      describeUserNow(),
    ]);
    return formatGoalsNote(goals, tz.isoDate);
  } catch (err) {
    // Extra context only: the agent can still reach goals through list_goals.
    console.error("[goals] could not load active goals for the prompt", err);
    return "";
  }
}
