# Oracle server: persistent Boop and existing dashboard

Run Boop as `ubuntu`, using the existing checkout at `/opt/boop-agent`.
The backend listens on `127.0.0.1:3456`; the existing Vite dashboard listens
on `127.0.0.1:5173`. Both run as systemd **user** services. Telegram needs
outbound access only. No Oracle firewall ports need to be opened for these
services.

## Repair and check the Linux sandbox

```bash
cd /opt/boop-agent
npm run server:doctor
```

On Ubuntu 24.04, if bubblewrap is installed but user namespace creation is
denied, use Ubuntu's targeted AppArmor profile:

```bash
sudo apt update
sudo apt install bubblewrap apparmor-profiles apparmor-utils
sudo install -m 0644 \
  /usr/share/apparmor/extra-profiles/bwrap-userns-restrict \
  /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
npm run server:doctor
```

This persistently updates policy for bubblewrap. The check must pass as
`ubuntu`, without running bubblewrap as root. The repair follows the
[official Codex prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites).
If the distribution profile is unavailable, inspect the error before changing
any global namespace/AppArmor settings.

Boop's isolated Codex homes now live under
`~/.local/state/boop/codex-homes/`, which avoids Codex's refusal to create
PATH helpers under `/tmp`. Each run is still isolated and read-only, shares
the existing Codex login, and cleans up its own home on completion. Override
the parent directory with `BOOP_CODEX_STATE_DIR` if needed; use a private
directory outside OS temporary storage.

## Install services once

Stop any foreground `npm start` with Ctrl+C before installing the service so
two Telegram pollers don't use the same bot token. Then:

```bash
cd /opt/boop-agent
git pull --ff-only
nvm use 22
npm ci
npm run server:doctor
npm run server:install
sudo loginctl enable-linger ubuntu
systemctl --user status boop boop-dashboard --no-pager
```

The installer writes `boop.service` and `boop-dashboard.service` under
`~/.config/systemd/user/`, then enables and starts them. It records the
current absolute Node executable and PATH, so systemd can find the same nvm
Node and Codex installation without sourcing `.bashrc`. Run it again after
changing your Node installation path. It does not copy `.env.local` or auth
tokens into the unit files. Linger lets the user services survive logout and
start after reboot. No machine-wide Boop service runs as root.

Useful commands:

```bash
journalctl --user -u boop -u boop-dashboard -f
systemctl --user restart boop boop-dashboard
systemctl --user stop boop-dashboard boop
```

The dashboard uses the existing private Vite server and its existing API/WS
proxy. This is appropriate for the personal alpha over SSH. The backend's
`BOOP_HOST` default is loopback; leave it at `127.0.0.1` for this deployment.

## Open the dashboard from your Mac

Keep this tunnel running in a Mac terminal, using your Oracle SSH identity:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:5173:127.0.0.1:5173 \
  -i ~/.ssh/ssh-key-oracle-mc.key ubuntu@YOUR_SERVER_IP
```

Open `http://localhost:5173` on the Mac. Only the dashboard port needs to be
forwarded: its API and WebSocket requests are proxied to the backend on the
server. Closing this tunnel disconnects the browser while Boop keeps running.
If local port 5173 is occupied, use
`-L 127.0.0.1:15173:127.0.0.1:5173` and browse to `http://localhost:15173`.

## Connect Google Calendar

1. Create/use your Composio account and get its project API key.
2. On the server, edit `/opt/boop-agent/.env.local` and set
   `COMPOSIO_API_KEY`. Keep `COMPOSIO_USER_ID` stable; leave its existing value
   unchanged if you've already connected anything. Don't paste API keys into
   Telegram or commit them.
3. Run `systemctl --user restart boop boop-dashboard` to load the key.
4. Open the dashboard over the tunnel, go to **Connections**, and connect
   **Google Calendar** (`googlecalendar`). Complete the hosted Google OAuth
   flow in your Mac browser. Google may request both read and write scopes;
   this fork does not enforce a read-only Calendar tool allowlist.
5. Close the completed OAuth popup, let Connections refresh, and verify the
   correct Google account is connected. If the UI reports that your own auth
   config is needed, follow its Composio auth-config link before retrying.
6. Ask Boop to remember that you use **Google Calendar**, then ask for tomorrow's
   events. Calendar reads don't require public webhook exposure. Leave
   `PUBLIC_URL` blank unless you're deliberately setting up inbound webhooks.

Add other connections individually after Calendar works. Local Apple cards
do not provide Apple Calendar access on this Linux server.
