// Do-not-disturb window for messages Boop starts on its own: free-time
// check-ins and hourly task nudges. Reminders the user scheduled for a
// specific time still go out. Pure helpers here; storage is in
// quiet-hours-store.ts so timing code stays testable without Convex.

export interface QuietHours {
  /** Local 24-hour "HH:mm" when quiet starts. */
  start: string;
  /** Local 24-hour "HH:mm" when it ends. Earlier than start means overnight. */
  end: string;
  enabled: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "08:00", enabled: true };
export const QUIET_HOURS_KEY = "quiet_hours";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export const minutesOfClock = (clock: string) => +clock.slice(0, 2) * 60 + +clock.slice(3, 5);

export function inQuietHours(clock: string, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? clock >= quiet.start && clock < quiet.end
    : clock >= quiet.start || clock < quiet.end;
}

/** Minutes from `clock` until quiet hours next start (Infinity when off). */
export function minutesUntilQuiet(clock: string, quiet: QuietHours = DEFAULT_QUIET_HOURS): number {
  if (!quiet.enabled || quiet.start === quiet.end) return Infinity;
  return (minutesOfClock(quiet.start) - minutesOfClock(clock) + 1440) % 1440;
}

/** Normalizes "9:00", "9", "21:30" to "HH:mm"; undefined if it isn't a clock time. */
export function normalizeClock(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const clock = `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
  return CLOCK.test(clock) ? clock : undefined;
}

/** Applies a partial change, returning the new value or an error message. */
export function updateQuietHours(current: QuietHours, patch: { start?: unknown; end?: unknown; enabled?: unknown }): QuietHours | string {
  const start = patch.start === undefined ? current.start : normalizeClock(patch.start);
  const end = patch.end === undefined ? current.end : normalizeClock(patch.end);
  if (!start) return "start must be a 24-hour time like 22:00.";
  if (!end) return "end must be a 24-hour time like 08:00.";
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return "enabled must be true or false.";
  const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
  if (enabled && start === end) return "start and end can't be the same time; turn quiet hours off instead.";
  return { start, end, enabled };
}

export function parseQuietHours(raw: string | null | undefined): QuietHours {
  if (!raw) return DEFAULT_QUIET_HOURS;
  try {
    const parsed = updateQuietHours(DEFAULT_QUIET_HOURS, JSON.parse(raw));
    return typeof parsed === "string" ? DEFAULT_QUIET_HOURS : parsed;
  } catch {
    return DEFAULT_QUIET_HOURS;
  }
}

function clock12(clock: string) {
  const h = +clock.slice(0, 2);
  const suffix = h < 12 ? "AM" : "PM";
  const m = clock.slice(3);
  return `${h % 12 || 12}${m === "00" ? "" : `:${m}`} ${suffix}`;
}

/** "10 PM to 8 AM", or "off". */
export function describeQuietHours(q: QuietHours): string {
  return q.enabled ? `${clock12(q.start)} to ${clock12(q.end)}` : "off";
}
