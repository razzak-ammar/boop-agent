# Tasks and the daily lookahead

Some things have to happen but have no fixed time. Reminders need a clock time
and goals need a deadline, so Boop tracks these as **tasks** and follows up
until they're done. Talk to it normally:

- "Sometime within a week of my flight back to Atlanta, remind me to fill out the reflection form."
- "I need to study for the exam, I just don't know when it is yet."
- "Make sure I renew my license this month, it's a big deal if I don't."
- "Remind me every hour until I submit the application."
- "Sometime today I need to call the bank before 5pm, keep checking on me."
- Replies: "done", "not yet, Thursday", "help me find the form", "stop asking until Monday", or a Telegram swipe-reply to the nudge.

## What gets stored

A task (`tasks` table) has a title, notes, an optional local-date window
(`earliest`/`latest`), an optional calendar **anchor**, `waitingOn` (what's
still unknown, such as "exam date"), importance, a nudge cadence in days, and
nudge history. Progress notes go into `taskUpdates`.

An anchored task stores the event's id plus a relation: "after" makes
`[event day, event day + N]` and "before" makes `[event day - N, event day]`.
Each lookahead run looks the event up again. If it moved, the window moves with
it. If it disappeared, the next message says so and asks for the new date.

When/whether to nudge is computed in code ([server/tasks/timing.ts](../server/tasks/timing.ts)):

| State | Nudged when |
|---|---|
| `upcoming` (window not open) | never |
| `in_window` | the day it opens, then every `cadenceDays`; daily for high importance within 2 days of the end |
| `last_day`, `overdue` | daily |
| `undated` | every `cadenceDays` (asks about `waitingOn`) |
| `snoozed` | not until `snoozedUntil` |

Daily-cadence tasks are nudged at most once a day. A progress note from the user resets the clock.

### Hourly check-ins

A task with `cadenceHours` ("every hour until…", or anything due today) is
checked by a **task pulse** automation every 15 minutes. It's created
automatically with the first hourly task. The pulse only reads the database and
calls the model only when a task is due. Rules:

- nudge every `cadenceHours` (default 2, 1 for high importance, when there's a
  `dueTime`; 3 for "sometime today"),
- no hourly pings 22:00-08:00, unless the deadline is within the hour,
- a last call within the hour before `dueTime`,
- one "did it happen?" right after `dueTime` passes, then the daily overdue nudge,
- it stops as soon as the task is marked done, dropped, or snoozed.
Default cadence is 2 days for dated tasks and 3 for undated ones (1 and 2 for
high importance).

## The daily lookahead

`create_task` makes sure a daily lookahead automation exists (`delivery:
"lookahead"`, 09:00 local by default). You can turn it on, off, or change the
time ("think ahead for me every morning at 8"). Each run gives the model:

- open tasks with their timing,
- the next 10 days of calendar events, each marked if it has already been asked about,
- active goals (summarized; they keep their own check-ins),
- recent conversation and the memory profile.

It writes one message, at most 3 items, or `SKIP`. That covers due nudges plus
questions about upcoming events that need prep: flights (check-in, getting to
the airport, a status check), exams, interviews, forms, RSVPs, birthdays. The
model ends with `NUDGED:`/`ASKED:` lines. Those lines are removed before
sending, and only after delivery does the app record them, so the same event
isn't raised twice and a failed send isn't counted as a nudge. If no task is due,
no new event exists, and no goal deadline is within 3 days, the model isn't called.

## Flights

`search_calendar_events` now reads event locations, matches codes regardless of
spacing (`DL1234` finds `DL 1234`), and labels flight-like events with
`flight: { code, airline, icao, airports }`. Detection uses real airline codes
only, so a course like "CS 1301" doesn't count. `flightsOnly: true` returns only
flights. For live status, workers use the code and date with FlightAware
(ICAO, e.g. `DAL1234`) or the airline's own status page.

## Telegram replies

A swipe-reply carries the message being replied to (and any highlighted quote)
into the turn. That lets the agent tell which nudge, check-in, or event "done"
refers to.
