# Telegram + Codex alpha

This fork supports private, text-only Telegram conversations and delivery of
Boop's recurring automation results. The server uses outbound long polling;
no Sendblue account, inbound webhook, public port, or ngrok tunnel is required.

## First run on your Mac

1. Install dependencies with `npm ci` (Node 20 or newer).
2. Create a bot through Telegram's verified **@BotFather** using `/newbot`.
   Put its token in `.env.local`; don't paste it into chat or commit it.
3. Set `TELEGRAM_ALLOWED_USER_ID` to your numeric Telegram user ID. This must
   be your own account ID, not the bot ID or your username. We can look it up
   during connection setup. Private messages are accepted only when both sender
   and chat ID match this ID. Groups, bots, edited messages, and all other users
   are ignored.
4. Copy `.env.example` to `.env.local` and fill in:

   ```dotenv
   BOOP_RUNTIME=codex
   BOOP_CODEX_MODEL=gpt-6-luna
   BOOP_CODEX_REASONING_EFFORT=low
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_ALLOWED_USER_ID=your-numeric-user-id
   SENDBLUE_AUTO_WEBHOOK=false
   ```

   Leave Sendblue credentials blank. Both Telegram fields must be supplied;
   leaving both blank disables the adapter, and partial config fails startup.
5. Install/update the Codex CLI using `npm install -g @openai/codex`, then run
   `codex login` with your ChatGPT account. The selected model must be available
   to that account. No API key is needed for this subscription runtime. On
   Oracle, `codex login --device-auth` supports signing in from another device.
6. Run `npx convex dev --once` to choose/configure your hosted development
   deployment and generate Convex files. Keep the deployment variables it
   writes in `.env.local`. This adapter adds no tables or schema changes.
7. Run `npm start`. This starts the server and Telegram poller, without the
   development orchestrator's dashboard/tunnel processes. Open your bot's
   conversation on your phone and tap **Start**, then send a text message.
   `/start` confirms transport connectivity without calling the model.

For the dashboard, run `npm run dev:debug` in a second terminal and open the
local URL. Set your timezone in Settings or tell Boop to set it before asking
for a recurring reminder. Test a short recurring reminder, then disable it.
Boop's existing automation tool schedules **recurring cron tasks**; one-time
reminders are not added by this change.

## Models

The runtime, setup wizard, and dashboard now share the current Codex model
catalog. Luna with low reasoning is the lightweight default. `luna` and `mini`
resolve to `gpt-6-luna`; `sol`, `terra`, and `astra` are available alternatives.
Retired GPT-5 model IDs are no longer offered. Retired saved selections fall
back to the configured current model (or Luna). Existing saved current models
and runtime/reasoning settings in Convex still take precedence over env values;
use dashboard Settings to switch an existing installation to Codex/Luna/Low.
The catalog does not verify account entitlement. Unknown model cost estimates
remain unavailable; token counts are recorded, and a zero estimate is not free
usage. Background memory extraction and consolidation also use subscription
allowance. No account-wide Codex settings are changed by this fork.

## Oracle deployment

See [ORACLE_SERVER.md](./ORACLE_SERVER.md) for persistent user services,
the sandbox repair, SSH dashboard forwarding, and Google Calendar setup.

Deploy this checkout separately with its own `.env.local`, hosted Convex
production deployment, and Codex login. Run `npm start` under a service manager.
Only run **one server per bot token**: don't run the Mac poller while Oracle is
running it. A bot with an existing webhook is refused rather than silently
disconnecting another app. No Telegram routes are opened on the HTTP server.
Keep the debug/API ports private.

Persist `data/telegram/` (or set an absolute `TELEGRAM_STATE_DIR`) across
restarts and include it in backups. Checkpoints are written atomically after
each update, and duplicate update IDs are skipped. Turns run sequentially so
a burst of notes doesn't race conversation history. A process crash between
an action and its checkpoint can replay that turn; this is not exactly-once
execution. Agent and delivery failures are logged without raw request URLs,
bot tokens, or Telegram response bodies. They aren't automatically replayed:
an action may already have happened. Check the dashboard before retrying.
Transient polling errors retry every five seconds. Telegram rate-limit errors
on outbound messages are logged as delivery failures; there is no durable
delivery/retry queue yet. Messages are split into plain-text chunks, with no
Telegram Markdown parsing.

The alpha does not add photos, voice transcription, Google Calendar, todos,
tracker tools, Markdown writing, daily backups, or one-time reminder scheduling.
Those are subsequent integrations.

## Privacy

Codex subscription login does not provide API Zero Data Retention guarantees.
Messages travel through Telegram and OpenAI; Boop also persists conversations,
memories, and task logs in hosted Convex. Telegram bot chats are not Secret
Chats. This change does not change account training/retention controls, create
cloud accounts, or send any test content to a model or a live bot.

References: [Telegram Bot API](https://core.telegram.org/bots/api),
[Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli),
[current models](https://learn.chatgpt.com/docs/models).

### Fast note capture

Send `/remember` followed by a paragraph to save the full text immediately.
Boop then extracts searchable personal facts in the background, using one model
request instead of a dispatcher/tool loop plus extraction. The original note
remains saved if extraction is incomplete or fails. Use ordinary chat for
questions, reminders, actions, or messages with images; those keep the full
conversational flow. `/remember` treats its text as a note, not an instruction
to execute actions embedded in it.

### Reminders

One-time and flexible recurring reminders are supported. Try “remind me in 30
minutes,” “tomorrow at 9am,” “every Monday and Friday,” “every other day at 9am
starting November 2,” or “every three hours.” Plain reminders send their saved
text without a model call at delivery. Ask to list, pause, delete, or reschedule
them. Local clock times need your saved timezone. See [reminder details](docs/REMINDERS.md)
for restart, DST, retry, and timing behavior.

Boop shows Telegram's typing indicator while processing a text message, refreshing
it during longer requests. It stops refreshing before the final/error reply.
Typing status is best-effort and does not block replies or consume model tokens.
