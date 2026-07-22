#!/usr/bin/env bash
set -euo pipefail

SKIP_BUILD=0
NO_OPEN=0
BACKGROUND=0
PORT="${SERVER_MONITOR_PORT:-3001}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-open)
      NO_OPEN=1
      shift
      ;;
    --background)
      BACKGROUND=1
      shift
      ;;
    --port)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --port" >&2
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./run.sh [--skip-build] [--no-open] [--background] [--port 3001]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "Server Monitor launcher"
echo "Project: $PROJECT_ROOT"

if [[ ! -f ".env" ]]; then
  echo "Missing .env. Create it from .env.example before starting." >&2
  exit 1
fi

if [[ ! -f "config/servers.json" ]]; then
  echo "Missing config/servers.json. Create it from config/servers.json.example before starting." >&2
  exit 1
fi

if [[ ! -d "node_modules/@wechatbot/wechatbot" ]]; then
  echo "Installing dependencies (required for WeChat alerts and runtime modules)..."
  npm install
fi

if command -v lsof >/dev/null 2>&1; then
  mapfile -t PIDS < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN || true)
  for pid in "${PIDS[@]}"; do
    if [[ -n "$pid" ]]; then
      echo "Stopping existing process on port $PORT: $pid"
      kill "$pid" || true
    fi
  done
elif command -v fuser >/dev/null 2>&1; then
  if fuser "${PORT}/tcp" >/dev/null 2>&1; then
    echo "Stopping existing process on port $PORT"
    fuser -k "${PORT}/tcp" || true
  fi
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "Building dashboard..."
  npm run build
fi

export SERVER_MONITOR_PORT="$PORT"

HEALTH_URL="http://127.0.0.1:${PORT}/api/overview"
APP_URL="http://127.0.0.1:${PORT}"

open_browser() {
  if [[ "$NO_OPEN" -eq 1 ]]; then
    return
  fi
  if command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
    xdg-open "$APP_URL" >/dev/null 2>&1 || true
  fi
}

if [[ "$BACKGROUND" -eq 0 ]]; then
  open_browser
  echo "Starting dashboard in this terminal: $APP_URL"
  echo "Press Ctrl+C to stop it."
  npm start
  exit $?
fi

echo "Starting dashboard in the background on $APP_URL ..."
if command -v setsid >/dev/null 2>&1; then
  # Detach from the launcher's session so the server survives SSH logout,
  # terminal closure, and non-interactive process supervisors.
  setsid -f npm start > server-monitor.log 2>&1 < /dev/null
  SERVER_PID="detached"
else
  nohup npm start > server-monitor.log 2>&1 < /dev/null &
  SERVER_PID=$!
fi

READY=0
for _ in {1..20}; do
  sleep 0.5
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      READY=1
      break
    fi
  fi
done

if [[ "$READY" -eq 0 ]]; then
  echo "Dashboard process started, but health check did not respond yet. PID: $SERVER_PID" >&2
  echo "Logs: $PROJECT_ROOT/server-monitor.log" >&2
  exit 1
fi

echo "Dashboard is running: $APP_URL"
open_browser
