import type { RecordData } from "./client.js";

function partsAt(epoch: number, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}
function offsetAt(epoch: number, timezone: string): number {
  const p = partsAt(epoch, timezone);
  return (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - Math.floor(epoch / 1000) * 1000) / 60_000;
}
export function localInstant(instant: string, timezone: string): { iso: string; label: string } {
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) throw new Error("Invalid TimeTracker timestamp.");
  const p = partsAt(epoch, timezone);
  const offset = offsetAt(epoch, timezone);
  const minutes = Math.abs(offset);
  const suffix = `${offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const milliseconds = new Date(epoch).getUTCMilliseconds();
  const fraction = milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : "";
  return {
    iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${fraction}${suffix}`,
    label: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(epoch)),
  };
}
/** Resolve a wall-clock time by round-tripping candidate offsets, including DST folds/gaps. */
export function resolveLocalTime(date: string, time: string, timezone: string, occurrence?: "earlier" | "later"): { utc: string; local: string; label: string; timezone: string } {
  const wall = `${date}T${time}:00`;
  const nominal = Date.parse(`${wall}Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== wall) {
    throw new Error("Supply a valid local date YYYY-MM-DD and 24-hour time HH:mm.");
  }
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) offsets.add(offsetAt(nominal + hours * 3600_000, timezone));
  const candidates = [...offsets].map(offset => nominal - offset * 60_000).filter(epoch => localInstant(new Date(epoch).toISOString(), timezone).iso.slice(0, 19) === wall).sort((a, b) => a - b);
  if (!candidates.length) throw new Error("That local time does not exist because the clocks move forward. Ask the user for a valid time.");
  if (candidates.length > 1 && !occurrence) throw new Error("That local time occurs twice when the clocks move back. Ask the user whether they mean the earlier or later occurrence.");
  const epoch = occurrence === "later" ? candidates[candidates.length - 1] : candidates[0];
  const utc = new Date(epoch).toISOString();
  const local = localInstant(utc, timezone);
  return { utc, local: local.iso, label: local.label, timezone };
}
export function localizeEvent(event: RecordData, timezone: string | null): RecordData {
  return {
    ...event,
    localTime: timezone ? {
      timezone,
      start: typeof event.startTime === "string" ? localInstant(event.startTime, timezone) : null,
      end: typeof event.endTime === "string" ? localInstant(event.endTime, timezone) : null,
    } : { timezone: null, instruction: "Ask the user to set their timezone before interpreting local dates or times." },
  };
}
export function eventPreview(event: Record<string, unknown>, timezone: string): string {
  const start = typeof event.startTime === "string" ? localInstant(event.startTime, timezone).label : "unknown start";
  const end = typeof event.endTime === "string" ? localInstant(event.endTime, timezone).label : "running";
  return `${start} – ${end} (${timezone}); project ${String(event.projectId)}; ${String(event.description || "no description")}`;
}
