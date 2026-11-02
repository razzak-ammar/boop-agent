import { z } from "zod";
import { boopUserId, getComposio, listConnectedToolkits } from "../composio.js";
import { getStoredUserTimezone } from "../timezone-config.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText } from "../runtimes/types.js";
import { searchCalendarEvents, type CalendarRead } from "./search.js";

export function createCalendarTools() {
  return [defineRuntimeTool("boop-calendar", "search_calendar_events",
    "Search Google Calendar events reliably across every accessible calendar (including hidden calendars), or explicitly named calendars. The server follows pagination, expands recurring events, includes all-day events, matches ANY term case-insensitively in titles/descriptions, and sorts chronologically. Use for next exams, midterms, quizzes, meetings, and calendar lookups. Terms are alternatives, NOT a Boolean query string. Results include search coverage: if complete=false, never claim absence or the globally earliest event. If resultsTruncated=true, don't claim all results were returned. No writes.", {
      terms: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
      calendarNames: z.array(z.string().trim().min(1)).max(20).optional().describe("Exact names or IDs only when the user specified a calendar. Omit to search all calendars."),
      start: z.string().optional().describe("Window start YYYY-MM-DDTHH:mm[:ss], interpreted in the saved user timezone, or a timestamp with an explicit offset. Default now."),
      end: z.string().optional().describe("Exclusive window end; same format as start."),
      daysAhead: z.number().int().min(1).max(366).default(90),
      limit: z.number().int().min(1).max(200).default(50),
      connectedAccountId: z.string().optional(),
    }, async args => {
      const timezone = await getStoredUserTimezone();
      if (!timezone) return runtimeText("Set the user's timezone before calendar lookups.", false);
      const composio = getComposio();
      if (!composio) return runtimeText("Google Calendar is unavailable: Composio is not configured.", false);
      const active = (await listConnectedToolkits()).filter(account => account.slug === "googlecalendar" && account.status === "ACTIVE");
      const account = args.connectedAccountId ? active.find(account => account.connectionId === args.connectedAccountId) : active.length === 1 ? active[0] : undefined;
      if (!account) return runtimeText(`Choose an active Google Calendar account. Available: ${active.map(account => `${account.connectionId} (${account.accountLabel ?? account.alias ?? "Calendar account"})`).join(", ") || "none"}.`, false);
      const read: CalendarRead = async (tool, parameters) => composio.tools.execute(tool, {
        userId: boopUserId(), connectedAccountId: account.connectionId, arguments: parameters, dangerouslySkipVersionCheck: true,
      });
      try {
        const result = await searchCalendarEvents(args, read, timezone);
        return runtimeText(JSON.stringify(result), result.complete);
      } catch {
        return runtimeText("Calendar search could not complete. Check the requested date window and connection; no absence claim is supported.", false);
      }
    })];
}
