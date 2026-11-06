// Pure timing rules for tasks. The lookahead model words the nudge, but
// whether a task is actionable and due for a nudge is decided here so it is
// consistent and testable.
import { daysBetween } from "../goals/pacing.js";

export interface TimingTask {
  earliest?: string;
  latest?: string;
  importance: "normal" | "high";
  cadenceDays: number;
  snoozedUntil?: string;
  /** Local "HH:mm" on the latest day: "before 8pm today". */
  dueTime?: string;
  /** Nudge every N hours instead of every N days ("remind me every hour until..."). */
  cadenceHours?: number;
  lastNudgedAt?: number;
  lastUpdateAt?: number;
  createdAt: number;
  nudgeCount: number;
}

export type TaskState = "undated" | "upcoming" | "in_window" | "last_day" | "overdue" | "snoozed";

export interface TaskTiming {
  state: TaskState;
  /** Days until the window opens (upcoming). */
  opensIn?: number;
  /** Days until the window closes, counting today as 0 on the last day. */
  daysLeft?: number;
  /** Days past the end of the window. */
  daysOverdue?: number;
  /** Minutes until dueTime on the last day (negative once passed). */
  minutesLeft?: number;
  dueForNudge: boolean;
  reason?: string;
}

const DAY = 86400000;
// The sweep runs at the same local time daily; allow drift so a 2-day cadence
// isn't skipped because the previous run finished a few minutes later.
const SLACK = 3 * 3600000;
const HOUR = 3600000;
// The pulse runs every 15 minutes; don't skip an hourly nudge over a few minutes.
const HOURLY_SLACK = 10 * 60000;
// No hourly pings overnight unless a deadline is within the hour.
export const QUIET_START = "22:00";
export const QUIET_END = "08:00";

const minutesOf = (clock: string) => +clock.slice(0, 2) * 60 + +clock.slice(3, 5);
export function inQuietHours(clock: string): boolean {
  return clock >= QUIET_START || clock < QUIET_END;
}

export function addDays(date: string, days: number): string {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + days * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Window implied by a calendar anchor: "within a week after my flight back"
 * is [flight day, flight day + 7]. */
export function windowFromAnchor(date: string, relation: "before" | "after", days: number) {
  return relation === "after"
    ? { earliest: date, latest: addDays(date, days) }
    : { earliest: addDays(date, -days), latest: date };
}

/** localClock is the user's current local "HH:mm"; without it, time-of-day
 * rules (dueTime, quiet hours) are skipped. */
export function taskTiming(task: TimingTask, today: string, now = Date.now(), localClock?: string): TaskTiming {
  if (task.snoozedUntil && daysBetween(today, task.snoozedUntil) > 0)
    return { state: "snoozed", dueForNudge: false };

  let state: TaskState;
  const timing: Partial<TaskTiming> = {};
  if (!task.earliest && !task.latest) state = "undated";
  else if (task.earliest && daysBetween(today, task.earliest) > 0) {
    state = "upcoming";
    timing.opensIn = daysBetween(today, task.earliest);
  } else if (task.latest && daysBetween(task.latest, today) > 0) {
    state = "overdue";
    timing.daysOverdue = daysBetween(task.latest, today);
  } else if (task.latest && task.latest === today) {
    timing.daysLeft = 0;
    if (task.dueTime && localClock) timing.minutesLeft = minutesOf(task.dueTime) - minutesOf(localClock);
    if (timing.minutesLeft !== undefined && timing.minutesLeft < 0) {
      state = "overdue";
      timing.daysOverdue = 0;
    } else state = "last_day";
  } else {
    state = "in_window";
    if (task.latest) timing.daysLeft = daysBetween(today, task.latest);
  }

  const lastContact = Math.max(task.lastNudgedAt ?? 0, task.lastUpdateAt ?? 0, task.createdAt);
  const since = now - lastContact;
  const nudgedToday = task.lastNudgedAt !== undefined && now - task.lastNudgedAt < DAY - SLACK;
  let due = false;
  let reason: string | undefined;
  const minutesLeft = timing.minutesLeft;
  if (task.cadenceHours && state !== "upcoming") {
    const closing = minutesLeft !== undefined && minutesLeft >= 0 && minutesLeft <= 60;
    const justMissed = minutesLeft !== undefined && minutesLeft < 0 && minutesLeft >= -60;
    if (justMissed) {
      // One "did it happen?" right after the deadline, if the last contact
      // was before it; after that the daily overdue nudge takes over.
      due = since > -minutesLeft * 60000;
      if (due) reason = "deadline just passed";
    } else if (state === "overdue") {
      // Once per later day, at the first pulse after quiet hours end: due when
      // the last contact happened before this morning's 08:00.
      if (localClock) {
        const sinceMorning = (minutesOf(localClock) - minutesOf(QUIET_END)) * 60000;
        due = !inQuietHours(localClock) && since > sinceMorning;
      } else due = !nudgedToday;
      if (due) reason = "window has passed";
    } else if (closing && since >= 30 * 60000) {
      due = true;
      reason = "deadline within the hour";
    } else if (localClock && inQuietHours(localClock)) {
      due = false;
    } else if (since >= task.cadenceHours * HOUR - HOURLY_SLACK) {
      due = true;
      reason = `no contact for ${task.cadenceHours}+ hour(s)`;
    }
    return { state, ...timing, dueForNudge: due, ...(reason ? { reason } : {}) };
  }
  if (state === "upcoming") {
    due = false;
  } else if (nudgedToday) {
    due = false;
  } else if (state === "last_day" || state === "overdue") {
    due = true;
    reason = state === "last_day" ? "last day of the window" : "window has passed";
  } else if (state === "in_window" && task.earliest === today) {
    due = true;
    reason = "window opens today";
  } else if (state === "in_window" && task.importance === "high" && (timing.daysLeft ?? Infinity) <= 2) {
    due = true;
    reason = "high importance and closing soon";
  } else if (since >= task.cadenceDays * DAY - SLACK) {
    due = true;
    reason = `no contact for ${task.cadenceDays}+ day(s)`;
  }
  return { state, ...timing, dueForNudge: due, ...(reason ? { reason } : {}) };
}

export function defaultCadence(importance: "normal" | "high", dated: boolean): number {
  if (dated) return importance === "high" ? 1 : 2;
  return importance === "high" ? 2 : 3;
}

/** Default hourly cadence for same-day tasks ("sometime today before 8pm"). */
export function defaultCadenceHours(importance: "normal" | "high", hasDueTime: boolean): number {
  if (hasDueTime) return importance === "high" ? 1 : 2;
  return 3;
}
