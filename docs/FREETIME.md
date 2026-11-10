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
| A timed event ended in the last 10 minutes (once per event) | During an event, or 22:00–08:00 |
| About once an hour while you're free (the heartbeat) | Gaps under 20 minutes before the next event |
| | No open tasks or active goals |
| | Within 45 minutes of any message after an event ends, or 90 minutes for the heartbeat |

Because the cooldown is checked before the model is called, a message the model writes is
always sent. Any message in the chat (yours, a reminder, another check-in) resets the
cooldown, so free-time check-ins never stack up behind other messages.

All-day events are not busy time. To make a calendar's timed events not count as busy (a
"Deadlines" calendar, say), list it in `BOOP_FREETIME_IGNORE_CALENDARS` (comma-separated names).

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
