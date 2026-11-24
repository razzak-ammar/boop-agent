# Boop for iOS

A minimal, dark, native SwiftUI client for Boop: one conversation, streamed
replies, and a live view of whether the agent is thinking, working, or typing.

Requires Xcode 26+ and iOS 26.

## Server setup

The app talks to the server's `/app` API, which stays off until you give it a token.

1. Add a token to the server's `.env.local` and restart the server:

   ```bash
   echo "BOOP_APP_TOKEN=$(openssl rand -hex 24)" >> .env.local
   ```

2. Make the server reachable from your phone. The server listens on
   `127.0.0.1`, so the simplest route is [Tailscale](https://tailscale.com) on
   both the server and the phone:

   ```bash
   tailscale serve --bg 3456
   ```

   That gives you `https://<machine>.<tailnet>.ts.net`. Only `/app/*` requests
   with the token get through; every other route still answers to localhost only.

## App setup

1. Open `ios/Boop.xcodeproj`, pick your team under Signing, and run.
2. On first launch Settings opens: paste the server URL and the token.

## What's where

| File | Purpose |
|---|---|
| `ChatStore.swift` | The conversation, the in-flight turn, the typewriter, the on-disk cache |
| `BoopClient.swift` | `/app` API: history, streamed chat (SSE), live changes, model config |
| `ChatView.swift` | The single chat screen |
| `Orb.swift` | The agent's face; its motion shows the current state |
| `SettingsView.swift` | Appearance, chat behaviour, model, server |

The app shows the cached conversation on the first frame and syncs in the
background. Reminders and automation results appear live while the app is open;
there are no push notifications yet.

## API

All routes need `Authorization: Bearer $BOOP_APP_TOKEN`.

| Route | |
|---|---|
| `GET /app/messages?limit=` | Recent messages of the app conversation (`BOOP_APP_CONVERSATION_ID`, default `app:owner`) |
| `POST /app/chat {content}` | One turn as server-sent events: `status` (`thinking` / `working` + label / `responding`), `delta`, `ack`, `reply`, `error` |
| `GET /app/events` | Long-lived stream; emits `changed` when the conversation changes server-side |
| `GET` / `POST /app/config` | Runtime, model and reasoning effort, plus the model lists |
