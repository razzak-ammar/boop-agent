import { Cron, CronDate } from "croner";

export interface ScheduleFields {
  scheduleKind?: "cron" | "once" | "interval" | "calendar";
  schedule: string;
  nextRunAt?: number;
  intervalMs?: number;
  intervalDays?: number;
  anchorAt?: number;
  timezone?: string;
}
export interface ScheduleInput {
  schedule?: string;
  at?: string;
  afterSeconds?: number;
  everySeconds?: number;
  everyDays?: number;
}
function localStamp(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}
/** Interpret local wall time with Croner's timezone support, never the host zone.
 * Gaps and ambiguous fall-back times require an explicit UTC offset. */
export function parseReminderTime(
  text: string,
  timezone: string,
  allowAmbiguous = false,
): number {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      text,
    );
  if (!match)
    throw new Error(
      "Use YYYY-MM-DDTHH:mm[:ss], optionally with Z or a UTC offset.",
    );
  const local = `${match[1]}T${match[2]}:${match[3] ?? "00"}`;
  const validDate = new Date(`${local}Z`);
  if (
    !Number.isFinite(validDate.getTime()) ||
    validDate.toISOString().slice(0, 19) !== local
  )
    throw new Error("Invalid calendar date or clock time.");
  if (match[4]) {
    const instant = Date.parse(text);
    if (!Number.isFinite(instant)) throw new Error("Invalid UTC offset.");
    return instant;
  }
  const instant = new CronDate(local, timezone).getDate().getTime();
  if (instant === undefined || localStamp(instant, timezone) !== local)
    throw new Error(
      "That local time does not exist due to daylight saving. Choose another time or specify an explicit offset.",
    );
  if (
    !allowAmbiguous &&
    [900000, 1800000, 2700000, 3600000, 5400000, 7200000, 10800000].some(
      (delta) =>
        localStamp(instant - delta, timezone) === local ||
        localStamp(instant + delta, timezone) === local,
    )
  )
    throw new Error(
      "That local time occurs twice due to daylight saving. Ask which occurrence, then specify its UTC offset.",
    );
  return instant;
}
export function nextCronRun(
  schedule: string,
  timezone: string,
  after = Date.now(),
): number | null {
  const job = new Cron(schedule, { paused: true, timezone });
  try {
    return job.nextRun(new Date(after))?.getTime() ?? null;
  } finally {
    job.stop();
  }
}
function calendarOccurrence(
  anchorAt: number,
  days: number,
  count: number,
  timezone: string,
): number {
  const stamp = localStamp(anchorAt, timezone);
  const date = new Date(`${stamp.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days * count);
  // Recurrences keep the wall clock; DST gaps are skipped, not shifted.
  return parseReminderTime(
    `${date.toISOString().slice(0, 10)}T${stamp.slice(11)}`,
    timezone,
    true,
  );
}
export function followingRun(
  a: ScheduleFields,
  now: number,
  timezone = a.timezone ?? "UTC",
): number | null {
  if (a.scheduleKind === "once") return null;
  if (a.scheduleKind === "interval") {
    if (!a.intervalMs || a.anchorAt === undefined) return null;
    return (
      a.anchorAt +
      Math.max(0, Math.floor((now - a.anchorAt) / a.intervalMs) + 1) *
        a.intervalMs
    );
  }
  if (a.scheduleKind === "calendar") {
    if (!a.intervalDays || a.anchorAt === undefined) return null;
    const elapsedDays = Math.floor(
      (Date.parse(localStamp(now, timezone).slice(0, 10)) -
        Date.parse(localStamp(a.anchorAt, timezone).slice(0, 10))) /
        86400000,
    );
    const start = Math.max(1, Math.floor(elapsedDays / a.intervalDays));
    for (let n = start; n < start + 370; n++) {
      try {
        const next = calendarOccurrence(
          a.anchorAt,
          a.intervalDays,
          n,
          timezone,
        );
        if (next > now) return next;
      } catch {
        /* skip nonexistent/ambiguous clock occurrences */
      }
    }
    return null;
  }
  return nextCronRun(a.schedule, timezone, now);
}
export function buildSchedule(
  input: ScheduleInput,
  timezone: string | null,
  now = Date.now(),
): ScheduleFields {
  const modes = [
    input.schedule !== undefined,
    input.afterSeconds !== undefined,
    input.everySeconds !== undefined,
    input.everyDays !== undefined,
  ];
  if (modes.filter(Boolean).length > 1 || (!modes.some(Boolean) && !input.at))
    throw new Error(
      "Choose one schedule: at, afterSeconds, cron schedule, everySeconds, or everyDays (intervals may include an at start).",
    );
  if (
    input.at &&
    (input.schedule !== undefined || input.afterSeconds !== undefined)
  )
    throw new Error("at cannot be combined with cron or a delay.");
  const positive = (value: number, min: number, max: number) => {
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`Interval must be between ${min} and ${max}.`);
  };
  const requiresZone =
    input.schedule !== undefined ||
    input.everyDays !== undefined ||
    (input.at !== undefined && !/(Z|[+-]\d{2}:\d{2})$/.test(input.at));
  if (requiresZone && !timezone)
    throw new Error(
      "Ask the user for their timezone first, then set_timezone. Never use the server's timezone.",
    );
  const zone = timezone ?? "UTC";
  if (input.schedule !== undefined) {
    if (input.schedule.trim().split(/\s+/).length !== 5)
      throw new Error("Use a 5-field cron expression.");
    const nextRunAt = nextCronRun(input.schedule, zone, now);
    if (nextRunAt === null)
      throw new Error("This schedule has no future occurrence.");
    return {
      scheduleKind: "cron",
      schedule: input.schedule,
      timezone: zone,
      nextRunAt,
    };
  }
  let first = input.at ? parseReminderTime(input.at, zone) : undefined;
  if (input.afterSeconds !== undefined) {
    positive(input.afterSeconds, 1, 315360000);
    first = now + input.afterSeconds * 1000;
  }
  if (input.everySeconds !== undefined) {
    positive(input.everySeconds, 60, 315360000);
    first ??= now + input.everySeconds * 1000;
    if (first <= now)
      throw new Error("The first reminder must be in the future.");
    return {
      scheduleKind: "interval",
      schedule: `Every ${input.everySeconds % 3600 === 0 ? `${input.everySeconds / 3600} hours` : input.everySeconds % 60 === 0 ? `${input.everySeconds / 60} minutes` : `${input.everySeconds} seconds`}`,
      intervalMs: input.everySeconds * 1000,
      anchorAt: first,
      nextRunAt: first,
      ...(timezone ? { timezone } : {}),
    };
  }
  if (input.everyDays !== undefined) {
    positive(input.everyDays, 1, 3650);
    if (!Number.isInteger(input.everyDays))
      throw new Error("everyDays must be an integer.");
    first ??= calendarOccurrence(now, input.everyDays, 1, zone);
    if (first <= now)
      throw new Error("The first reminder must be in the future.");
    return {
      scheduleKind: "calendar",
      schedule: `Every ${input.everyDays} calendar days`,
      intervalDays: input.everyDays,
      anchorAt: first,
      timezone: zone,
      nextRunAt: first,
    };
  }
  if (first === undefined || first <= now)
    throw new Error("The reminder time must be in the future.");
  return {
    scheduleKind: "once",
    schedule: `Once: ${new Date(first).toISOString()}`,
    nextRunAt: first,
    anchorAt: first,
    ...(timezone ? { timezone } : {}),
  };
}
