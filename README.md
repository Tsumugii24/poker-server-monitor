# Server Monitor

TypeScript dashboard for monitoring Linux servers over SSH.

## Setup

1. Install Node.js 22 or newer, then install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`, then fill in your SSH credentials:

```bash
cp .env.example .env
```

For Linux deployments that should accept direct network access, set:

```env
SERVER_MONITOR_HOST=0.0.0.0
```

Keep `SERVER_MONITOR_HOST=127.0.0.1` when running locally or behind Nginx/Caddy.

For Hugging Face access through a Clash HTTP proxy, configure the backend and remote solver proxy
separately:

```env
SERVER_MONITOR_HF_PROXY_URL=http://127.0.0.1:7890
SOLVER_HF_PROXY_URL=http://127.0.0.1:7890
SUBSCRIPTION_URL=https://your-mihomo-subscription-url
GITEE_USERNAME=Tsumugii24
GITEE_TOKEN=your-gitee-personal-access-token
```

`SERVER_MONITOR_HF_PROXY_URL` is used by this app when checking dataset progress or creating
repositories. `SOLVER_HF_PROXY_URL` is exported into remote solver tmux commands when Upload is
enabled. After setting these values, enable the matching switches in Settings → Connection Check.
If either the `.env` value is empty or the dashboard switch is off, that path connects directly.

`SUBSCRIPTION_URL` is used only by the manual **Server Operations > Sync Network** action.
It is sent directly to selected SSH servers; the UI, operation database, and command previews
retain only the `$SUBSCRIPTION_URL` placeholder.

`GITEE_USERNAME` must be the Gitee login/personal-space name associated with the token.
`GITEE_TOKEN` is used as the HTTPS Git password when Sync Network clones or pulls
`mihomo-release`. The token is passed through a temporary remote `GIT_ASKPASS` script and is
redacted from the UI, operation database, and command previews. If the token belongs to
`Tsumugii24`, the default username can be kept.

Parallel solver allocation uses the solver board list from `cards/cards.txt`. By default the
backend looks under the configured server `solverRoot` values, such as `~/solver/cards/cards.txt`.
If the monitor host keeps that file somewhere else, set:

```env
SERVER_MONITOR_SOLVER_CARDS_PATH=/home/user/solver/cards/cards.txt
```

3. Create the local server inventory:

```bash
cp config/servers.json.example config/servers.json
```

Then edit `config/servers.json` with your real servers. Credentials are read only by the backend. Do not put passwords in `config/servers.json`.

4. Optional: create local alert settings:

```bash
cp config/alerts.json.example config/alerts.json
```

Offline WeChat alerts are disabled by default. You can also configure them from the dashboard Settings panel; the app writes those settings to `config/alerts.json`. This file is ignored by Git.

## WeChat Alerts

The dashboard can send a WeChat message to every enabled, verified recipient when an enabled server is detected as `offline`.

1. Open the Settings button in the top bar.
2. The first tab is `Recipients`. Click `Add` to create a new recipient login flow.
3. The dashboard switches to the connection tab and renders a WeChat ClawBot QR code. The QR status auto-refreshes while login is pending; use `Refresh QR` if the code expires.
4. After QR login, ask that WeChat user to send any normal message to ClawBot.
5. The connection tab shows detected inbound messages. Select the latest message and verify the recipient.
6. Enable or pause recipients as needed. Edit recipient labels or remove stale recipients from the same list.
7. Choose English or Chinese alert language, set the cooldown minutes, and save.
8. Use the per-recipient test button or the global `Send test alert` action to verify delivery.

The WeChat ClawBot channel needs a per-user `context_token` before it can proactively send to a contact. That token is issued only after the user sends a message to ClawBot. The app stores the SDK login state plus token metadata under `data/wechat-accounts/`, which is ignored by Git.

Context token behavior:

- The token appears to expire after about 24 hours without an inbound message from that user.
- If send fails with `ret=-2`, the Settings UI marks the exact recipient that must send any message to ClawBot again.
- The backend records target activity in `target_activity.json` beside the SDK storage so reminder state survives restarts.
- A background reminder check runs 30 seconds after startup and then every 15 minutes. It only sends when a verified recipient is in the `23h <= last inbound age < 24h` window, and only once for that token lifecycle.
- If the reminder itself hits `ret=-2`, the normal stale-token UI path applies.

Alert behavior:

- **Manual Refresh** always sends a WeChat alert when any enabled server is `offline`.
- **Scheduled checks** run at the configured auto alert interval (default 60 minutes) and send only if that interval has passed since the last alert, whether the last alert came from a manual or automatic refresh.
- Only `offline` servers are included. `unknown` or online-but-unhealthy servers do not trigger offline alerts.

Offline alert messages only include the affected server address and port. Server names and inventory IDs are intentionally omitted from forwarded alerts.

If `Recent WeChat chats` stays empty, check the same Settings panel:

- `Polling` must be `Running`.
- `Messages seen` should increase after you send a message.
- `Last error` should be empty.

If polling is running but `Messages seen` remains `0`, the WeChat SDK did not receive that group message. Send another message after polling is running, try mentioning the logged-in bot account in the group, then click `Refresh status`.

## Development

```bash
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend API: `http://127.0.0.1:3001`

## Production Build

```bash
npm run build
npm start
```

Production app: `http://127.0.0.1:3001` by default.

## One-Click Start

### Windows

Run this from PowerShell:

```powershell
./run.ps1
```

Useful options:

```powershell
./run.ps1 -SkipBuild
./run.ps1 -NoOpen
./run.ps1 -Port 3001
./run.ps1 -Background
```

### Linux

Run this from a shell:

```bash
chmod +x ./run.sh
./run.sh
```

Useful options:

```bash
./run.sh --skip-build
./run.sh --no-open
./run.sh --port 3001
./run.sh --background
```

Both scripts check for `.env` and `config/servers.json`, stop any existing listener on the selected port when possible, optionally rebuild the app, and start the dashboard. By default the server runs in the current terminal, so `Ctrl+C` stops it.

## Verification

```bash
npm run typecheck
npm test -- --run
npm run build
```
