import { parseReminderTime } from "../reminder-schedule.js";

type Row = Record<string, unknown>;
export type CalendarRead = (tool: "GOOGLECALENDAR_LIST_CALENDARS" | "GOOGLECALENDAR_EVENTS_LIST", args: Row) => Promise<unknown>;
export interface CalendarSearchInput {
  terms?: string[];
  calendarNames?: string[];
  start?: string;
  end?: string;
  daysAhead?: number;
  limit?: number;
}
interface Calendar { id: string; name: string; accessRole?: string }
export interface CalendarMatch {
  id: string; calendarId: string; calendarName: string; title: string;
  start: string; end?: string; allDay: boolean; localStart: string;
  description?: string; url?: string;
  matchedTerms: string[];
}
export interface CalendarCoverage {
  id: string; name: string; complete: boolean; eventsScanned: number; issue?: string;
}
const MAX_PAGES = 20;
const MAX_CALENDARS = 100;
const FIELDS = "items(id,status,summary,description,start,end,htmlLink),nextPageToken";
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value : undefined;

function data(response: unknown): Row {
  const envelope = row(response);
  if (envelope.successful === false || envelope.error) throw new Error("Calendar provider could not complete this read.");
  if (!envelope.data || typeof envelope.data !== "object") throw new Error("Calendar provider returned an unrecognized response.");
  return row(envelope.data);
}
function token(value: Row): string | undefined {
  return text(value.nextPageToken) || text(value.next_page_token);
}
function startInstant(start: Row, timezone: string): number {
  const dateTime = text(start.dateTime);
  if (dateTime) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(dateTime)) throw new Error("Event time is missing its UTC offset.");
    const instant = Date.parse(dateTime);
    if (!Number.isFinite(instant)) throw new Error("Event time is invalid.");
    return instant;
  }
  const date = text(start.date);
  if (!date) throw new Error("Event start is missing.");
  return parseReminderTime(`${date}T00:00`, timezone, true);
}

/** Enumerate and filter on the server. Provider free-text queries are never
 * assembled from Boolean expressions, and the model never receives raw event
 * metadata it would have to scan to find the earliest matching event. */
export async function searchCalendarEvents(input: CalendarSearchInput, read: CalendarRead, timezone: string, now = Date.now()) {
  const timeMin = input.start ? parseReminderTime(input.start, timezone) : now;
  const timeMax = input.end ? parseReminderTime(input.end, timezone) : timeMin + (input.daysAhead ?? 90) * 86400000;
  if (timeMax <= timeMin || timeMax - timeMin > 366 * 86400000) throw new Error("Choose a calendar window of at most 366 days, with end after start.");
  const terms = [...new Set((input.terms ?? []).map(term => term.trim().toLocaleLowerCase()).filter(Boolean))];
  if (terms.some(term => /\s(?:OR|AND)\s/i.test(term))) throw new Error("Pass alternative terms as separate array entries, not a Boolean query string.");
  const requested = (input.calendarNames ?? []).map(name => name.trim().normalize("NFKC").toLocaleLowerCase());
  const calendars = new Map<string, Calendar>();
  const issues: string[] = [];
  const seenCalendarTokens = new Set<string>();
  let calendarPage: string | undefined;
  let discoveryComplete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const result = data(await read("GOOGLECALENDAR_LIST_CALENDARS", {
        show_hidden: true, max_results: 250, ...(calendarPage ? { page_token: calendarPage } : {}),
      }));
      const values = result.calendars ?? result.items;
      if (!Array.isArray(values)) throw new Error("Missing calendar list.");
      for (const value of values) {
        const item = row(value);
        const id = text(item.id);
        if (item.deleted === true) continue;
        if (!id) { issues.push("A calendar entry had no usable ID."); continue; }
        calendars.set(id, { id, name: text(item.summaryOverride) ?? text(item.summary) ?? id, accessRole: text(item.accessRole) });
      }
      calendarPage = token(result);
      if (!calendarPage) { discoveryComplete = true; break; }
      if (seenCalendarTokens.has(calendarPage)) throw new Error("Calendar pagination did not advance.");
      seenCalendarTokens.add(calendarPage);
    } catch {
      issues.push("Calendar discovery was incomplete; cannot claim every calendar was checked.");
      break;
    }
  }
  if (!discoveryComplete && !issues.length) issues.push("Calendar discovery reached its page limit.");
  const selected = [...calendars.values()].filter(calendar => !requested.length || requested.includes(calendar.name.normalize("NFKC").toLocaleLowerCase()) || requested.includes(calendar.id.toLocaleLowerCase()));
  for (const name of requested) {
    if (!selected.some(calendar => calendar.name.normalize("NFKC").toLocaleLowerCase() === name || calendar.id.toLocaleLowerCase() === name)) issues.push(`Requested calendar was not found: ${name}`);
  }
  if (selected.length > MAX_CALENDARS) issues.push(`Calendar scan limited to ${MAX_CALENDARS} calendars; narrow by calendarNames.`);
  const coverage: CalendarCoverage[] = [];
  const matches = new Map<string, CalendarMatch & { instant: number }>();
  // Small batches keep provider calls bounded without a serial round trip for
  // every old/hidden calendar. Every selected calendar still gets a receipt.
  for (let offset = 0; offset < Math.min(selected.length, MAX_CALENDARS); offset += 4) {
    await Promise.all(selected.slice(offset, Math.min(offset + 4, MAX_CALENDARS)).map(async calendar => {
      const scanned: CalendarCoverage = { id: calendar.id, name: calendar.name, complete: false, eventsScanned: 0 };
      coverage.push(scanned);
      if (calendar.accessRole === "freeBusyReader") {
        scanned.issue = "Only free/busy access; event titles cannot be searched.";
        return;
      }
      const seenTokens = new Set<string>();
      let pageToken: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = data(await read("GOOGLECALENDAR_EVENTS_LIST", {
            calendarId: calendar.id, timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(),
            timeZone: timezone, singleEvents: true, orderBy: "startTime", showDeleted: false,
            maxResults: 250, fields: FIELDS, ...(pageToken ? { pageToken } : {}),
          }));
          const items = result.items ?? (result.kind === "calendar#events" ? [] : undefined);
          if (!Array.isArray(items)) throw new Error("Missing event list.");
          for (const value of items) {
            scanned.eventsScanned++;
            const event = row(value);
            if (event.status === "cancelled") continue;
            const title = text(event.summary) ?? "Untitled event";
            const description = text(event.description) ?? "";
            const haystack = `${title}\n${description}`.toLocaleLowerCase();
            const matchedTerms = terms.filter(term => haystack.includes(term));
            if (terms.length && !matchedTerms.length) continue;
            const id = text(event.id);
            if (!id) { scanned.issue = "Some matching events had no event ID."; continue; }
            try {
              const start = row(event.start);
              const end = row(event.end);
              const instant = startInstant(start, timezone);
              const allDay = Boolean(text(start.date));
              const localStart = allDay ? text(start.date)! : new Intl.DateTimeFormat("en-US", {
                timeZone: timezone, dateStyle: "full", timeStyle: "short",
              }).format(instant);
              matches.set(`${calendar.id}:${id}`, {
                id, calendarId: calendar.id, calendarName: calendar.name, title,
                start: text(start.dateTime) ?? text(start.date)!, end: text(end.dateTime) ?? text(end.date),
                allDay, localStart, description: description ? description.slice(0, 300) : undefined,
                url: text(event.htmlLink), matchedTerms, instant,
              });
            } catch { scanned.issue = "Some matching event dates could not be interpreted."; }
          }
          pageToken = token(result);
          if (!pageToken) { scanned.complete = !scanned.issue; break; }
          if (seenTokens.has(pageToken)) throw new Error("Event pagination did not advance.");
          seenTokens.add(pageToken);
        }
        if (!scanned.complete && !scanned.issue) scanned.issue = "Event scan reached its page limit.";
      } catch { scanned.issue = "Event read failed or returned incomplete pagination."; }
    }));
  }
  const ordered = [...matches.values()].sort((a, b) => a.instant - b.instant || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const limit = input.limit ?? 50;
  return {
    complete: discoveryComplete && !issues.length && coverage.every(calendar => calendar.complete),
    window: { start: new Date(timeMin).toISOString(), end: new Date(timeMax).toISOString(), timezone },
    terms, calendarsChecked: coverage, issues, totalMatches: ordered.length,
    resultsTruncated: ordered.length > limit,
    earliestByTerm: Object.fromEntries(terms.map(term => {
      const found = ordered.find(event => event.matchedTerms.includes(term));
      if (!found) return [term, null];
      const { instant: _instant, ...event } = found;
      return [term, event];
    })),
    events: ordered.slice(0, limit).map(({ instant: _instant, ...event }) => event),
  };
}
