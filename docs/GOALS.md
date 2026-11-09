# Goals and check-ins

Boop can track deadlines you're working toward, check in on your progress, and
suggest a plan for today. Talk to it normally:

- "Midterm is Nov 12. 12 lectures, 75% by Saturday, 100% by Monday, nothing new the last 2 days."
- "Check in at 6pm Friday on the 75%."
- "Did 4 lectures today." / "I'm at 7."
- "What should I do today?"
- "Plan my day every morning at 8."
- "I'm done with that exam" / "drop the reading goal."

## What gets stored

A goal (`goals` table) has a title, a deadline (local `YYYY-MM-DD`), an
optional unit and total ("12 lectures"), current progress, dated milestones
with optional targets, and free-form plan notes. Each progress report goes into
`goalUpdates`, so check-ins can see the trend.

Progress is cumulative: "did 2 more" after 4 is stored as 6, so a repeated reply
can't double count.

Pacing is computed in code ([server/goals/pacing.ts](../server/goals/pacing.ts)),
not by the model. It covers days to the deadline, the next milestone, units
remaining, the per-day rate needed (counting today and the milestone day), and
missed milestones.

Creating a goal does not add calendar events. Ask for those separately, as before.

## Where goals show up

The debug dashboard's **Goals** tab lists goals from every conversation with
their pacing, milestones, notes and progress history. It is read-only; change
goals by talking to Boop.

On each user turn, the conversation's active goals are added to the interaction
agent's system prompt with their pacing, soonest deadline first (up to 20). The
agent knows them without a tool call and uses `list_goals` for progress history,
scheduled check-ins or goals beyond that limit.

## Check-ins

By default, `create_goal` schedules a check-in at 18:00 local time on the
evening before each milestone and the evening before the deadline. Slots that
have already passed are skipped. You can ask for daily check-ins, a different
time, or none. `schedule_checkin` adds one at any time; without a goal it
becomes a daily plan.

Check-ins are automations with `delivery: "checkin"`. Plain reminders send fixed
text. A check-in instead runs your configured model ([server/goals/checkin.ts](../server/goals/checkin.ts))
and gives it:

- the goal(s), their pacing and recent updates
- the last 20 messages of the conversation
- your memory profile
- the current local time
- `search_calendar_events`, when Google Calendar is connected

The model writes one message. Goal check-ins say where you should be and ask
for your number, or comment if you already reported today, and suggest a
catch-up if you're behind. Daily plans fit goal work into today's free time.
If nothing is worth sending, the model replies `SKIP` and no message goes out.

Your reply is a normal turn. The interaction agent logs it with
`log_goal_progress`, then reacts to the updated pacing. Marking a goal done or
dropped turns off its check-ins. A check-in that fires for an inactive goal
disables itself without a model call.

Check-in usage is recorded under the `proactive` source.
