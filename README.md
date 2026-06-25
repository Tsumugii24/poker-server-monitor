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

The dashboard can send a WeChat message to every enabled recipient when an enabled server is detected as `offline`.

1. Open the Settings button in the top bar.
2. Click `Start WeChat login`, then scan the QR code rendered in the dashboard. The QR status auto-refreshes while login is pending; use `Refresh QR` if the code expires.
3. Ask each alert recipient, or the target group, to send a normal message to the logged-in bot account.
4. Open the `Recipients` tab and add the detected contact from `Recent contacts`, or enter the WeChat contact ID manually.
5. Enable or pause recipients as needed. Edit or remove stale recipients from the same list.
6. Choose English or Chinese alert language, set the cooldown minutes, and save.
7. Use the per-recipient test button or the global `Send test alert` action to verify delivery.

The WeChat bot needs message context before it can proactively send to a contact or group. The Settings panel exposes the recent chat IDs that the bot has seen, so you do not need to manually inspect terminal logs for IDs. The `@wechatbot/wechatbot` SDK stores its login state locally, so do not commit generated WeChat credential files.

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
