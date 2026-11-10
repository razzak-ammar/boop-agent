# Free-time check-ins

When a free slot opens, Boop can text you about it:

> You're free until 8 and the chem problem set is due Thursday. Want to knock out a chunk now?

It's on once you have a task (`create_task` sets it up), or ask for it: "check in on me when I'm free".
Turn it off with "stop the free-time check-ins". Your reply is a normal turn, so "already on it",
"not now" or "done" work the way they do for any other nudge.

## When it talks

A **Free-time check-ins** automation ticks every 5 minutes. Each tick is database reads and a
calendar read (cached for 10 minutes). Plain code ([server/freetime/gate.ts](../server/freetime/gate.ts))
decides whether to wake the model:

| Wakes the model | Never wakes it |
|---|---|
| A timed event ended in the last 10 minutes (once per event) | During an event, or during quiet hours |
| About once an hour while you're free (the heartbeat) | Gaps under 20 minutes before the next event |
| | No open tasks or active goals |
| | Within 45 minutes of any message after an event ends, or 90 minutes for the heartbeat |

Because the cooldown is checked before the model is called, a message the model writes is
always sent. Any message in the chat (yours, a reminder, another check-in) resets the
cooldown, so free-time check-ins never stack up behind other messages.

## Quiet hours

A do-not-disturb window for messages Boop starts on its own: free-time check-ins and hourly
task nudges. It's 22:00 to 08:00 by default and stored as the `quiet_hours` setting. Reminders you
scheduled for a specific time still go out, and an hourly task whose deadline is within the hour
can still get its last call.

Change it any of three ways:

- Text Boop: "quiet hours 11pm to 7am", "don't message me before 9", "turn off quiet hours".
  (`configure_quiet_hours` tool.)
- The dashboard: **Heartbeat → Quiet hours**.
- The API: `GET /quiet-hours` returns `{ start, end, enabled, description }`, and
  `PUT /quiet-hours` with any of `{ "start": "23:00", "end": "07:00", "enabled": true }` saves
  a change. Times are local 24-hour; an end earlier than the start means overnight.

## Which calendars mean "busy"

Pick them in the dashboard under **Heartbeat → Busy calendars**
(stored as the `freetime_busy_calendars` setting). Only timed events on those calendars
block time, and only their ends trigger a check-in. That keeps shared calendars, like a lab's
availability calendar or a room booking calendar, from making you look booked all day. Those
calendars are also left out of the prompt, except for all-day items (due dates, trips), which
are context from any calendar. With nothing picked, every calendar counts.

## What the model sees

The free window ("free for about 98 minutes, until Dinner at 8:00 PM"), why it was woken,
today's calendar, open tasks with their timing, active goals with pacing, the last 20 messages,
and your memory profile. It writes one or two sentences or replies `SKIP`, which is the normal
outcome. It reads the conversation, so if you said "not now" or ignored the last check-in, it
waits until something changes. Tasks it raises count as nudged, the same as the lookahead.

## Model

On the Codex runtime this check runs on `gpt-6.1-terra` by default; set `BOOP_FREETIME_MODEL`
to another Codex model to change it. On the Claude runtime it uses your configured model.
Usage is recorded under the `proactive` source.

## The Heartbeat tab

The debug dashboard's **Heartbeat** tab is where all of this lives:

- **Status**: what the heartbeat sees right now. Whether it's asleep for quiet hours, watching, or due to check in; how long you're free; when the next busy event ends; when it last woke the model; and when the chat last had a message. It's computed by `GET /freetime/status` without calling the model or changing anything.
- **Settings**: the on/off switch for free-time check-ins, quiet hours, and busy calendars.
- **Activity**: a live log of every decision that reached the model, plus event ends it let pass. Rows show the trigger (after an event, or the hourly check), the outcome (Sent, Stayed quiet, Let it pass, Send failed, Error), the message it wrote, and the model, tokens and time taken. Rows are kept for 30 days in the `heartbeatEvents` table.

