# Server Monitor

Local TypeScript dashboard for monitoring Linux servers over SSH.

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Create `.env` from `.env.example`:

```env
SSH_USERNAME=your-ssh-username
SSH_PASSWORD=your-ssh-password
SERVER_MONITOR_PORT=3001
SERVER_MONITOR_DB_PATH=data/server-monitor.sqlite
SERVER_MONITOR_REFRESH_INTERVAL_MS=3600000
```

3. Edit `config/servers.json`:

```json
[
  {
    "id": "prod-01",
    "name": "Production 01",
    "host": "192.168.1.10",
    "port": 22,
    "group": "production",
    "enabled": true
  }
]
```

Credentials are read only by the backend. Do not put passwords in `config/servers.json`.

## Development

```powershell
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend API: `http://127.0.0.1:3001`

## Production Build

```powershell
npm run build
npm start
```

Production app: `http://127.0.0.1:3001`

## Verification

```powershell
npm run typecheck
npm test -- --run
npm run build
```
