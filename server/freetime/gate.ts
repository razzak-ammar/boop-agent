// Free-time check-ins: the plain-code gate. Runs every few minutes and decides
// whether a free-slot check-in is worth a model call at all. Everything that
// would make a message pointless (quiet hours, mid-event, a chat that was just
// active, nothing to suggest) is checked here, so the model is only woken when
// whatever it writes can actually be sent.
import { DEFAULT_QUIET_HOURS, inQuietHours, minutesOfClock, minutesUntilQuiet, type QuietHours } from "../quiet-hours.js";

export const FREE_TIME = {
  /** How often the automation ticks. Ticks are database and calendar reads only. */
  everySeconds: 5 * 60,
  /** While free, wake the model at most this often. */
  heartbeatMinutes: 60,
  /** An event counts as "just ended" for this long after its end. */
  endWindowMinutes: 10,
  /** No heartbeat check-in within this long of any message in the chat. */
  cooldownMinutes: 90,
  /** The end of an event is the best moment to ask, so it waits less. */
  afterEventCooldownMinutes: 45,
  /** A gap shorter than this isn't worth suggesting anything for. */
  minFreeMinutes: 20,
};

export interface BusyEvent {
  /** Stable per event instance (calendarId:eventId). */
  key: string;
  title: string;
  start: number;
  end: number;
}

export interface FreeTimeInput {
  now: number;
  /** Local 24-hour "HH:mm". */
  clock: string;
  /** Timed events on today's calendar (all-day items are not busy time). */
  events: BusyEvent[];
  /** Event-end keys already acted on (see endKey). */
  handled: Set<string>;
  /** Newest message in the conversation, from either side. */
  lastMessageAt?: number;
  /** Last time this check called the model. */
  lastCheckAt?: number;
  /** Open tasks or active goals exist, so there's something to suggest. */
  hasWork: boolean;
  /** Do-not-disturb window; 22:00-08:00 when omitted. */
  quiet?: QuietHours;
}

export type FreeTimeTrigger = "event_ended" | "heartbeat";

export interface FreeTimeDecision {
  trigger?: FreeTimeTrigger;
  /** Why the gate decided this; logged, and given to the model when it wakes. */
  reason: string;
  ended?: BusyEvent;
  /** The next busy event, if there is one before quiet hours. */
  next?: BusyEvent;
  /** Minutes until the next busy event or quiet hours, whichever is first. */
  freeMinutes: number;
  /** Event ends to record as handled, whether or not the model is woken. */
  markHandled: string[];
}

export const endKey = (e: BusyEvent) => `freetime-end:${e.key}:${e.end}`;

const minutesBetween = (later: number, earlier: number) => Math.floor((later - earlier) / 60000);

export function decideFreeTime(i: FreeTimeInput): FreeTimeDecision {
  const quiet = i.quiet ?? DEFAULT_QUIET_HOURS;
  // Free time runs until quiet hours start, or midnight when they're off.
  const toQuiet = Math.min(minutesUntilQuiet(i.clock, quiet), 1440 - minutesOfClock(i.clock));
  const next = i.events
    .filter((e) => e.start > i.now && minutesBetween(e.start, i.now) < toQuiet)
    .sort((a, b) => a.start - b.start)[0];
  const freeMinutes = next ? minutesBetween(next.start, i.now) : toQuiet;
  const base = { freeMinutes, ...(next ? { next } : {}), markHandled: [] as string[] };

  if (inQuietHours(i.clock, quiet)) return { ...base, reason: "quiet hours" };
  const current = i.events.find((e) => e.start <= i.now && i.now < e.end);
  if (current) return { ...base, reason: `in "${current.title}"` };

  const window = FREE_TIME.endWindowMinutes * 60000;
  const ended = i.events
    .filter((e) => e.end <= i.now && i.now - e.end < window && !i.handled.has(endKey(e)))
    .sort((a, b) => a.end - b.end);
  const markHandled = ended.map(endKey);
  const withEnds = { ...base, markHandled };
  const sinceMessage = i.lastMessageAt === undefined ? Infinity : minutesBetween(i.now, i.lastMessageAt);

  if (!i.hasWork) return { ...withEnds, reason: "no open tasks or goals to suggest" };
  if (freeMinutes < FREE_TIME.minFreeMinutes)
    return { ...withEnds, reason: `only ${freeMinutes} min free${next ? ` before "${next.title}"` : ""}` };

  const last = ended.at(-1);
  if (last) {
    if (sinceMessage < FREE_TIME.afterEventCooldownMinutes)
      return { ...withEnds, reason: `"${last.title}" ended, but the chat was active ${sinceMessage} min ago` };
    return { ...withEnds, trigger: "event_ended", ended: last, reason: `"${last.title}" just ended` };
  }

  const sinceCheck = i.lastCheckAt === undefined ? Infinity : minutesBetween(i.now, i.lastCheckAt);
  if (sinceCheck < FREE_TIME.heartbeatMinutes) return { ...withEnds, reason: "heartbeat not due" };
  if (sinceMessage < FREE_TIME.cooldownMinutes)
    return { ...withEnds, reason: `heartbeat due, but the chat was active ${sinceMessage} min ago` };
  return { ...withEnds, trigger: "heartbeat", reason: "free, and no check-in for a while" };
}
