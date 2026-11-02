# TimeTracker integration

Boop includes a native `timetracker` integration for personal research and TA time
entries. It uses the HTTP API described in [the OpenAPI contract](time-tracker.openapi.json),
with no additional MCP service or Composio account. Both Claude and Codex runtimes
use the same tools. The main conversation agent has direct access: clear requests
are saved immediately without a worker or another approval turn. Follow-ups use
recent conversation, project memory and existing entries. Explicit draft/preview
requests remain supported with `draftOnly: true`.

## Setup

1. Deploy `functions:agentApi` from the TimeTracker repository. Use Firebase's
   printed endpoint, which ends with `/agentApi`. This integration does not deploy
   or change the TimeTracker backend.
2. From the Boop repository, run:

   ```sh
   npm run timetracker:connect
   ```

   Accept the API URL (or enter the deployed URL), then enter your existing
   TimeTracker email and password. The password is hidden, sent only to Firebase
   Auth, and never saved. The command discovers the public Firebase API key from
   Boop's config or a neighboring `time-tracker/web-app/.env.local`; otherwise it
   prompts for `NEXT_PUBLIC_FIREBASE_API_KEY` once.
3. The command checks the API with a read-only project request, then saves the
   configuration and refresh token privately in `.env.local`. It preserves other
   configuration. On failure or cancellation it leaves the configuration unchanged.
4. Restart Boop and ask it to check the TimeTracker connection or list projects.
   The dispatcher can select `integrations: ["timetracker"]`.
5. Set Boop's user timezone to `America/New_York` if not already configured.
   Local-day boundaries must use the offset in effect at each instant. On the
   November 1, 2026 DST transition, midnight is `-04:00`, while the next midnight
   is `-05:00`. Ambiguous local times require clarification.

The client exchanges the refresh token for a short-lived Firebase ID token,
caches it in memory, refreshes before expiry, and retries once after HTTP 401.
It persists rotated refresh tokens atomically with mode 0600 to
`data/time-tracker-session.json` (ignored by Git). Override with an absolute
`TIME_TRACKER_SESSION_FILE` path for a persistent private service directory.
Run only one Boop server per session file. Neither credentials nor upstream error
bodies are returned to the model or tool logs. Do not paste tokens into chat.

If refresh fails, sign in again, replace `FIREBASE_REFRESH_TOKEN`, and restart.
Replacing the environment token invalidates the old local cache automatically.
To disconnect Boop, clear these variables and remove the session cache. To revoke
access at Firebase, revoke the account's refresh tokens using a trusted account
administration flow; this can also sign out other sessions for that account.
These are account session credentials, not a separately scoped agent API token.

## Tools and writes

Tools: `resolve_local_time`, `check_connection`, `list_projects`, `get_project`, `create_project`,
`update_project`, `list_events`, `summarize_time`, `get_event`, `create_event`, `update_event`,
`delete_event`, `start_timer`, and `stop_timer`.

TimeTracker runs only on the main conversation agent. Delegating it to a worker is
refused, because workers cannot see the conversation's pending operations. Pending
(unsaved) operations from the last 7 days are shown to the main agent each turn, so
one cannot silently go missing; `list_drafts` reports when each was prepared.

Events are time entries, not calendar events. Write tools persist a durable
operation receipt (including a stable UUID for creates) before sending the write.
By default the main agent and workers execute clear requests immediately and mark
successful receipts sent. On failure the receipt stays pending with its original
ID so it can be inspected/retried without blindly creating another entry.

For an explicit preview/draft request, write tools accept `draftOnly: true` and
return a pending draft. `list_drafts` and `get_draft` recover its full details;
`update_draft` applies partial corrections while preserving the original entry ID,
dates and other fields. It creates a revised draft and rejects the old one; use
the returned replacement ID. `send_draft` publishes it when requested. DELETE
moves the entry to recoverable trash; restore remains in the tracker app.

Before an update/delete, Boop re-reads the entry and compares `updatedAt` with the
version captured in the draft. Changes since staging block execution and require
a new draft. This is a best-effort check: the API has no atomic ETag precondition,
so another client can still edit between the check and the write. Likewise,
active-timer checks cannot atomically prevent a simultaneous start in another
client. Stop operations send `isActive: false` and `endTime` together. Timer times
are captured when staging, not when approval arrives.

Creates always reuse the UUID saved in the draft. After a timeout, 409 or server
failure, Boop reads that ID and compares intended fields, normalizing timestamps.
A collision alone is not success. If recovery cannot verify the create, the draft
remains pending with its original ID. There is no blind POST retry with a new ID.

`create_event` returns `already_saved` with the existing entry, instead of writing a
duplicate, when the same project already has an entry within a minute of the same
start and end. Overlapping entries are saved but returned as `overlaps` to mention.

List tools traverse every page, including empty pages with a cursor, and fail
explicitly after 1,000 pages rather than silently returning partial data.
`list_events` takes inclusive local `fromDate`/`toDate` (YYYY-MM-DD), selects entries
by start time, defaults to the last 14 days, and returns compact rows (project name,
local start/end labels, minutes, a 200-character description) capped at the newest
200. `get_event` returns the full record. `summarize_time` totals minutes by project
and by local day, splitting entries at local midnights and range edges and counting a
running timer to now; it looks back 24 hours for entries that started before the
range. TimeTracker's own reporting aggregates use UTC days, so they are not used.

## Validation

```sh
npm run typecheck
npm test -- test/time-tracker.test.ts test/draft-listing.test.ts test/execution-prompt.test.ts
```

A checkout needs its normal generated Convex files before typechecking or tests.
Tests use mocked HTTP/Convex boundaries, never real credentials or time entries.

## Local dates and timezones

Agents receive the application's current local date, time and saved IANA
timezone for every run. If the timezone is unset, they must ask for it instead
of using the server's zone. Write tools never take UTC timestamps: `start` is a
local `{ date, time }` and `end` a local `{ time, date? }` (24-hour HH:mm). Without
an end date, an end not after the start rolls to the next day, so overnight
entries need only the end time. Boop converts each instant with the offset in effect
then. Model-built timestamps previously stored entries hours off. `start_timer` and
`stop_timer` default to now. Repeated DST wall times require an explicit
`occurrence` (`earlier` or `later`); nonexistent spring-forward times fail.
`resolve_local_time` remains for explaining a conversion.

Read tools and successful write results retain UTC storage fields and add
`localTime` with timezone, local ISO strings and human-readable labels. Event
draft summaries and previews show the local calendar date and time, so the user
can check the intended day before approval. Time-entry draft preparation requires
a confirmed timezone. UTC remains the API/storage format. New York follows EDT
or EST according to the event date, rather than a fixed UTC-5 offset all year.
