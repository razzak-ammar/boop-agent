# Calendar search

Calendar questions now have an application-owned, read-only tool:
`search_calendar_events`. It uses the same connected Composio Google Calendar
account as existing tools. No additional credentials or schema changes are
needed. Calendar writes still use the existing integration tools.

The dispatcher can call it directly; workers also receive it when Google
Calendar is included in their integrations. If multiple Calendar accounts are
connected, the tool requires selection of an actual connected account ID.

## Search behavior

- Enumerate accessible calendars, including hidden calendars, following
  calendar-list pagination. An explicit calendar name/ID restricts the scope;
  a missing named calendar never silently falls back to the primary calendar.
- Fetch the requested window from every selected calendar, expanding recurring
  events and following event page tokens, including empty intermediate pages.
- Match **any** supplied term case-insensitively in event titles/descriptions
  in application code. No synthetic `midterm OR quiz` query is sent upstream.
- Preserve all-day dates as calendar dates. Sort matches by their actual start
  time and supply the earliest result for each term.
- Return compact event IDs, calendar names/IDs, titles, dates/times, and short
  descriptions rather than full Google metadata for the model to scan.

Default scope is all accessible calendars on the selected account, now through
the next 90 days. Optional local start/end times use the saved user timezone;
RFC3339 times can specify their own offset. Windows are bounded to 366 days.

## Coverage and limits

Every result includes `complete`, the exact window/timezone, per-calendar
coverage, issues, and the total match count. Read failures, free/busy-only
access, malformed matching event dates, missing calendars, stuck pagination,
or scan limits prevent a complete-search claim. The agent must qualify partial
results and cannot report universal absence or a globally earliest match from
an incomplete scan.

Provider scans are bounded to 100 calendars and 20 pages per list. Four
calendars are read concurrently. The model receives at most `limit` results
(50 by default, maximum 200), with `resultsTruncated` indicating additional
matches. These output limits do not truncate the underlying scan silently.

## Verification

Unit tests reproduce the Academics midterm/quiz case, shuffled events,
recurring lectures crowding an exam onto a later page, empty pages with next
tokens, all-day date preservation, duplicate events, failed reads, missing
named calendars, and partial output. The opt-in live model case uses fixture
tools and performs no calendar mutations or message delivery:

```sh
node --import tsx scripts/check-codex-behavior.ts --case next-academic-assessment
```
