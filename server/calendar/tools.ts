import { z } from "zod";
import { boopUserId, getComposio, listConnectedToolkits } from "../composio.js";
import { getStoredUserTimezone } from "../timezone-config.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText } from "../runtimes/types.js";
import { searchCalendarEvents, type CalendarRead, type CalendarSearchInput } from "./search.js";

export function createCalendarTools() {
  return [defineRuntimeTool("boop-calendar", "search_calendar_events",
    "Search Google Calendar events reliably across every accessible calendar (including hidden calendars), or explicitly named calendars. The server follows pagination, expands recurring events, includes all-day events, matches ANY term case-insensitively in titles/locations/descriptions, and sorts chronologically. Use for next exams, midterms, quizzes, meetings, flights, and calendar lookups. Titles, locations and descriptions are searched; flight codes match with or without spaces ('DL1234' finds 'DL 1234'). Each event that looks like a flight carries flight={code, airline, icao, airports}. For 'my flight' questions use flightsOnly=true (optionally with a destination term) instead of guessing terms, because flights are often titled only by their code. Terms are alternatives, NOT a Boolean query string. Results include search coverage: if complete=false, never claim absence or the globally earliest event. If resultsTruncated=true, don't claim all results were returned. No writes.", {
      terms: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
      calendarNames: z.array(z.string().trim().min(1)).max(20).optional().describe("Exact names or IDs only when the user specified a calendar. Omit to search all calendars."),
      start: z.string().optional().describe("Window start YYYY-MM-DDTHH:mm[:ss], interpreted in the saved user timezone, or a timestamp with an explicit offset. Default now."),
      end: z.string().optional().describe("Exclusive window end; same format as start."),
      daysAhead: z.number().int().min(1).max(366).default(90),
      limit: z.number().int().min(1).max(200).default(50),
      flightsOnly: z.boolean().optional().describe("Return only events that look like flights: a real airline code (DL 1234), the word flight, an airport, or ✈. Combine with terms such as a city or airport code to narrow."),
      connectedAccountId: z.string().optional(),
    }, async args => {
      const out = await runCalendarSearch(args);
      if (typeof out === "string") return runtimeText(out, false);
      return runtimeText(JSON.stringify(out), out.complete);
    })];
}

/** Shared by the tool and by server-side readers (the lookahead sweep). Returns
 * a user-facing error string when the calendar can't be read. */
export async function runCalendarSearch(args: CalendarSearchInput & { connectedAccountId?: string }) {
  const timezone = await getStoredUserTimezone();
  if (!timezone) return "Set the user's timezone before calendar lookups.";
  const composio = getComposio();
  if (!composio) return "Google Calendar is unavailable: Composio is not configured.";
  const active = (await listConnectedToolkits()).filter(account => account.slug === "googlecalendar" && account.status === "ACTIVE");
  const account = args.connectedAccountId ? active.find(account => account.connectionId === args.connectedAccountId) : active.length === 1 ? active[0] : undefined;
  if (!account) return `Choose an active Google Calendar account. Available: ${active.map(account => `${account.connectionId} (${account.accountLabel ?? account.alias ?? "Calendar account"})`).join(", ") || "none"}.`;
  const read: CalendarRead = async (tool, parameters) => composio.tools.execute(tool, {
    userId: boopUserId(), connectedAccountId: account.connectionId, arguments: parameters, dangerouslySkipVersionCheck: true,
  });
  try {
    return await searchCalendarEvents(args, read, timezone);
  } catch {
    return "Calendar search could not complete. Check the requested date window and connection; no absence claim is supported.";
  }
}
