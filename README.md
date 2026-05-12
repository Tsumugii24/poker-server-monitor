# Server Monitor

TypeScript dashboard for monitoring Linux servers over SSH.

## Setup

1. Install dependencies:

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
.\run.ps1
```

Useful options:

```powershell
.\run.ps1 -SkipBuild
.\run.ps1 -NoOpen
.\run.ps1 -Port 3001
.\run.ps1 -Background
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
