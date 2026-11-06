# Reminders and scheduled work

Send requests naturally in Telegram:

- “Remind me in 30 minutes to take the laundry out.”
- “Remind me tomorrow at 9am to call Sam.”
- “Remind me every Monday, Wednesday, and Friday at 9am to stretch.”
- “Remind me every other day at 9am, starting November 2.”
- “Remind me every two weeks on Monday at 9am, starting November 2.”
- “Remind me every three hours to drink water.”
- “Remind me on the first of each month at 10am to review my budget.”
- “Move the laundry reminder to 6pm,” “pause it,” or “delete it.”

One-time dates are stored as absolute timestamps and disable themselves after
successful delivery. Calendar intervals preserve the local clock across month
boundaries and daylight saving changes; elapsed intervals such as every 48 hours
preserve elapsed duration instead. Cron supports selected weekdays, weekly,
monthly, and multiple times per day. Several unrelated dates can be saved as
separate one-time reminders. These are fixed schedules, not calendar-event or
todo-completion triggers.

Local wall-clock schedules require the user's saved IANA timezone. The server's
zone is never silently substituted. Relative delays need no timezone. A local
one-time clock time that is missing or repeated at a DST transition requires
clarification/an explicit offset. Calendar recurrences skip nonexistent spring
clock times; a repeated fall clock time has one occurrence, not two.

Plain reminders use `create_reminder` and deliver the saved text without model
inference at firing time. Research/integration work uses `create_automation`
and still runs an agent. Existing cron automations keep their behavior. Both
support pause, deletion, inspection, and `reschedule_automation`. Check-ins on
tracked goals and daily plans are a third kind; see [Goals and check-ins](GOALS.md).

The dashboard shows one-time versus recurring schedules, full next dates,
completion, and delivery failures. Completed one-time reminders cannot be
accidentally re-enabled by a toggle; reschedule them for a new future time.

Clock-only reminders use `localTime` (24-hour HH:mm) plus `day` (`today`,
`tomorrow`, or YYYY-MM-DD), resolved by the application in the saved timezone.
This prevents UTC already being tomorrow from shifting an evening reminder to
the next local day. A narrow guard rejects a conflicting timestamp for an
unambiguous “remind me at 8:30 pm to …” request. Past times are rejected rather
than silently moved to tomorrow. Replies include an application-generated
receipt with the actual saved weekday, calendar date, time, and timezone.

## Durability and delivery

Convex stores schedules, due timestamps, run history, and expiring execution
claims. A transaction claims each occurrence before work begins, excluding
concurrent scheduler ticks/processes. Heartbeats retain the claim during slow
work. On restart, overdue schedules are checked immediately; expired claims
are recovered after at most approximately two minutes. Missed recurring runs
are coalesced into one catch-up run, then the next future occurrence, rather
than replaying an entire backlog.

The scheduler polls about every 10 seconds. These are personal reminders, not
hard real-time alarms. If the server is off, a due reminder waits until it is
back online. Failed one-time deliveries retry after one minute, up to three
attempts; terminal failure stays visible in the dashboard.

Telegram/SMS delivery and the database update cannot share a transaction. A
crash or ambiguous transport error after sending but before recording success
can still cause a duplicate on recovery. Delivery is best-effort at least once,
not an exactly-once guarantee. Pausing/deleting before delivery is checked
again before sending, but cannot retract an already-sent message.

## Validation

Tests cover timezone/DST resolution, invalid/past/conflicting schedules,
weekday and monthly cron, anchored elapsed intervals, every-other-day across
month/DST boundaries, overlapping ticks, restart/expired-claim recovery, bounded
retries, completion/rescheduling, and no model invocation for plain delivery.
Convex lifecycle tests use convex-test against the actual schema and functions.
Opt-in live language-routing checks use fixture tools so no real reminder is
created or delivered:

    node --import tsx scripts/check-codex-behavior.ts --case one-time-reminder
    node --import tsx scripts/check-codex-behavior.ts --case selected-days
    node --import tsx scripts/check-codex-behavior.ts --case every-other-day
