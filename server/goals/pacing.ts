// Pure pacing math for goals. The check-in model reasons about the plan, but
// the arithmetic ("3 behind, 2/day to catch up") comes from here so it can't
// be miscounted.

export interface GoalMilestone {
  date: string;
  label: string;
  target?: number;
}

export interface PacingGoal {
  title: string;
  deadline: string;
  unit?: string;
  total?: number;
  progress: number;
  milestones: GoalMilestone[];
}

export interface MilestonePace {
  date: string;
  label: string;
  target?: number;
  daysAway: number;
  // Days left to work on it, counting today and the milestone day itself.
  workDays: number;
  remaining?: number;
  perDay?: number;
  missed: boolean;
}

export interface GoalPacing {
  today: string;
  daysToDeadline: number;
  progress: number;
  total?: number;
  unit?: string;
  percent?: number;
  next?: MilestonePace;
  missed: MilestonePace[];
  status: "on_track" | "behind" | "done" | "past_deadline" | "unknown";
}

/** Whole days from a to b, both local YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((utc(b) - utc(a)) / 86400000);
}

function pace(m: GoalMilestone, progress: number, today: string): MilestonePace {
  const daysAway = daysBetween(today, m.date);
  const workDays = Math.max(daysAway + 1, 0);
  const remaining = m.target === undefined ? undefined : Math.max(m.target - progress, 0);
  return {
    ...m,
    daysAway,
    workDays,
    remaining,
    perDay: remaining === undefined || workDays === 0 ? undefined : +(remaining / workDays).toFixed(2),
    missed: daysAway < 0 && remaining !== undefined && remaining > 0,
  };
}

export function computePacing(goal: PacingGoal, today: string): GoalPacing {
  const daysToDeadline = daysBetween(today, goal.deadline);
  const milestones = goal.milestones.map((m) => pace(m, goal.progress, today));
  const missed = milestones.filter((m) => m.missed);
  const next = milestones.find((m) => m.daysAway >= 0);
  const done = goal.total !== undefined && goal.progress >= goal.total;
  let status: GoalPacing["status"] = "unknown";
  if (done) status = "done";
  else if (daysToDeadline < 0) status = "past_deadline";
  else if (missed.length) status = "behind";
  else if (goal.total !== undefined) status = "on_track";
  return {
    today,
    daysToDeadline,
    progress: goal.progress,
    total: goal.total,
    unit: goal.unit,
    percent: goal.total ? Math.round((goal.progress / goal.total) * 100) : undefined,
    next,
    missed,
    status,
  };
}

/** Default check-in moments: the evening before each milestone and the
 * deadline, skipping any that have already passed. */
export function defaultCheckinDays(goal: Pick<PacingGoal, "deadline" | "milestones">, today: string): string[] {
  const dayBefore = (d: string) => {
    const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - 86400000);
    return t.toISOString().slice(0, 10);
  };
  const days = [...goal.milestones.map((m) => m.date), goal.deadline].map(dayBefore);
  return [...new Set(days)].filter((d) => daysBetween(today, d) >= 0).sort();
}
