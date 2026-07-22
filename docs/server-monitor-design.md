# Server Monitor Design

## Goal

Build a local-first server monitoring dashboard for 12 Linux servers. The app runs on the user's Windows machine, connects to the servers over SSH with one shared username and password, collects basic load metrics, stores the last 24 hours of history, and displays both an overall health view and per-server details.

The first version is intentionally scoped to local access only. It listens on localhost, does not expose SSH credentials to the frontend, and does not include multi-user auth.

## Confirmed Requirements

- All application code should be TypeScript.
- The server list is maintained by this app, not imported live from Termius.
- All monitored machines are Linux servers.
- All servers use the same SSH username and password.
- The dashboard is accessed only from the local machine.
- Default automatic refresh interval is 1 hour.
- Users can trigger a manual refresh.
- Refreshes should run all 12 SSH checks in parallel; no concurrency limit is needed.
- A refresh should not overlap with another active refresh.
- Metrics history should be retained for the most recent 24 hours.
- First version metrics are online status, CPU usage, memory usage, disk usage, system load, and uptime.
- First version server inventory is maintained in `config/servers.json`; a UI editor is out of scope.

## Architecture

The app will use a TypeScript monorepo-style structure:

- React + Vite frontend for the dashboard UI.
- Node.js TypeScript backend for API routes, SSH collection, scheduling, and persistence.
- Shared TypeScript types for API contracts and metric models.
- SQLite for local persistence.

The frontend talks only to the local backend API. It never receives the SSH password. The backend reads SSH credentials from environment variables or a local-only config source:

```env
SSH_USERNAME=...
SSH_PASSWORD=...
```

Server inventory is stored in `config/servers.json` and loaded by the backend. The backend can mirror these records into SQLite for joins and history queries, but the file is the first-version editing surface. Credentials are stored separately from inventory. A server record contains:

```ts
type ServerConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  group?: string;
  enabled: boolean;
};
```

## Data Flow

1. Scheduler starts an automatic refresh every hour.
2. User can start a manual refresh from the dashboard.
3. Backend checks whether a refresh is already running.
4. If no refresh is active, backend starts SSH collection for all enabled servers in parallel.
5. Each server has independent timeouts, such as 10 seconds for connection and 15 seconds for command execution.
6. Backend parses Linux command output into normalized metrics.
7. Backend stores one metric snapshot per server.
8. Backend records the refresh run summary.
9. Backend deletes metric snapshots older than 24 hours.
10. Frontend reads latest status, overview summary, and historical series through API endpoints.

## SSH Collection

The backend should execute Linux commands that are broadly available on standard distributions. The exact command set can be finalized during implementation, but the target fields are:

- CPU usage percent.
- Memory used percent.
- Root filesystem disk used percent.
- Load average values.
- Uptime seconds or formatted uptime.

Failure modes are first-class results, not crashes:

- SSH connection failure.
- SSH authentication failure.
- Command timeout.
- Unexpected command output.
- Partial parsing failure.

Each failure is stored with an error code and user-readable message so the dashboard can explain what happened.

## Persistence

SQLite tables:

### `servers`

Stores inventory:

- `id`
- `name`
- `host`
- `port`
- `group`
- `enabled`
- `created_at`
- `updated_at`

### `metric_snapshots`

Stores each collection result:

- `id`
- `server_id`
- `collected_at`
- `status`
- `cpu_used_percent`
- `memory_used_percent`
- `disk_used_percent`
- `load_1`
- `load_5`
- `load_15`
- `uptime_seconds`
- `error_code`
- `error_message`

### `refresh_runs`

Stores refresh round metadata:

- `id`
- `trigger`
- `started_at`
- `finished_at`
- `status`
- `success_count`
- `warning_count`
- `failure_count`

## Status Rules

Status values:

- `online`: SSH succeeds and all required metrics parse.
- `warning`: server is online but at least one configured threshold is exceeded.
- `offline`: SSH connection or authentication fails.
- `unknown`: no metrics have been collected yet, or parsing failed in a way that prevents trustworthy status.

Default warning thresholds:

- CPU usage >= 80%.
- Memory usage >= 80%.
- Disk usage >= 80%.

Thresholds can start as constants and become configurable later.

## User Interface

The UI has two main routes.

### Overview

The overview page shows macro-level monitoring:

- Online server count.
- Average CPU, memory, and disk usage across online servers.
- Warning and offline counts.
- Last refresh time and next scheduled refresh time.
- Manual refresh button.
- Overall 24-hour trend chart.
- A short overall description summarizing notable conditions, such as offline servers or high load.
- Server list with current status and core metrics.

The server list is clickable. Selecting a server opens the server detail route.

### Server Detail

The detail page shows one server:

- Current status.
- CPU, memory, disk, load, and uptime.
- Last check time.
- Latest error message if collection failed.
- 24-hour trend charts for CPU, memory, disk, and load.
- A link or button to return to the overview.
- Manual refresh remains all-server refresh in the first version.

### Settings / WeChat Alerts

The current implementation includes a settings workflow for WeChat ClawBot alert delivery:

- `Recipients` is the first tab. It lists configured recipients and exposes add, enable or pause, edit label, remove, and test actions.
- `Add` starts a new QR login flow instead of asking for a manual contact ID. Each recipient must complete its own ClawBot login and verification.
- The connection tab renders the QR code, supports QR refresh, shows detected inbound WeChat messages, and verifies the selected target user after that user sends a message.
- The same WeChat contact cannot be configured as duplicate recipients.
- Delivery status is surfaced as explicit phases such as awaiting context, ready, stale context, send error, and session expired.
- When a send fails with `ret=-2`, the UI marks the specific verified target user that must send any message to ClawBot again.

WeChat delivery relies on a per-user `context_token`. The token is issued by the iLink / ClawBot message stream when the user sends an inbound message to the bot. The app cannot make this token permanent; it stores token activity locally and treats `ret=-2` as a stale token signal.

Context refresh reminder behavior:

- Target activity is persisted per WeChat account in `target_activity.json` under `data/wechat-accounts/<accountId>/`.
- Before restoring an account, the monitor validates the SDK JSON files. Empty or truncated credentials, cursor, context-token, or typing-ticket files are moved to `.corrupt-<timestamp>` backups so one damaged file cannot block connector startup.
- `lastInboundAt` is reset whenever the target user sends ClawBot a message.
- The backend checks 30 seconds after startup and then every 15 minutes.
- A reminder is sent only when `23h <= now - lastInboundAt < 24h`.
- Each token lifecycle receives at most one reminder. A new inbound message clears the reminder marker.
- The reminder message asks the user to send any message to ClawBot to reactivate alert delivery.
- If the reminder send is already too late and returns `ret=-2`, the stale-token frontend prompt remains the recovery path.

### Solver Jobs / Server Operations

The current implementation also includes solver job orchestration for the shared `~/solver` deployment on each server:

- Single solver jobs submit one reviewed range to one selected server.
- Parallel solver jobs split remaining board indices across available servers and keep a queue for follow-up chunks. Runs submitted from the inventory-backed UI use a dynamic server pool: newly added enabled servers can claim still-queued chunks after they have an online, idle snapshot; already-running chunks are never split or moved. Explicit API submissions can keep a fixed server pool by omitting `autoIncludeNewServers`.
- The Failure Pool is scoped to the currently inspected Range and Dataset. Its count includes unresolved pending, queued, running, and failed entries; solved entries are omitted. Confirmed Clear removes only pending/failed entries in that exact scope and never removes queued/running retries.
- Terminal Parallel History records have a separate confirmed Delete action. It permanently removes the selected run, its report, slices, solver jobs, events, and failure-pool entries linked to that run. Active or locked runs cannot be deleted.
- A solver job stores the pipeline snapshot that settled it. Terminal slices are immutable during later reconciliation, so a newer task on the same server cannot overwrite historical Done, Failed, or Success Rate statistics.
- `Best Server` is treated as an operations-level setting. It is configured from the `Server Operations` tab and used by failure-pool retries that require the strongest fallback server.
- `Server Operations` is a manual maintenance center for work that runs across every SSH-ready server, not a single-server uploader.
- `Sync Code` starts a sync tmux session on each online enabled server. The remote command exports the solver proxy variables, runs `git stash`, then `git pull --rebase`.
- `Sync Network` clones or updates `~/mihomo-release`, expands the Mihomo binary, downloads `config.yaml` from the backend-only `SUBSCRIPTION_URL`, validates it, and restarts a persistent tmux session named `mihomo`. HTTPS Git authentication uses backend-only `GITEE_USERNAME` and `GITEE_TOKEN` through a temporary remote AskPass file; secrets are not retained in operation commands or reports.
- Solver dispatch checks SSH availability and idle state but does not inspect, update, or synchronize Git. When solver upload proxying is enabled, dispatch also requires the manually managed `mihomo` tmux session and a successful Hugging Face request through that proxy; otherwise the chunk remains queued with a `Sync Network` recovery message.
- Manual inventory refresh and parallel queue reconciliation run as background work. Each server snapshot is persisted as soon as its SSH checks finish, the UI shows completed/total refresh progress, and Server Operations remain usable while queue reconciliation continues. Alert delivery runs after snapshot persistence without extending the refresh lock.
- Parallel Queue and History reads return the persisted SQLite snapshot immediately. Reconciliation is scheduled separately, and related local status updates are persisted as one batch so a large restored queue cannot block the read endpoint by repeatedly exporting the full database. Movable queue entries are selected and swapped one position at a time with the left/right controls; active runs stay locked in place.
- Hugging Face dataset checks use exact Repo ID matching. A rename redirect such as `dataset` to `dataset-backup` is treated as a missing `dataset`, allowing the original name to be created independently after explicit confirmation instead of reading coverage from the backup.
- Range progress prefers the Hugging Face dataset size service. If that service is unavailable during a refresh, the remaining checks use paginated repository file listings and count unique solver board artifacts, matching Parallel Preview coverage instead of failing the entire batch.
- Multi-server code sync, network sync, result scans, and upload tmux startup use bounded concurrency instead of waiting for every server serially.
- `Scan All Results` inspects `~/solver/results/<dataset>/<job-id>` on every online enabled server and lists retained parquet/json result folders in a filterable, bounded-height inventory. Operators can select all folders matching the current Range/Dataset filter, then upload the selection or delete it without uploading. Each row retains its own targeted Upload/Delete actions.
- `Scan All Results` and `Scan + Upload All` are manually initiated. The latter performs a fresh scan server-side after confirmation before starting upload tmux sessions. Each server serially uploads every retained format in every assigned result folder through `python upload.py --results-dir <dir> --repo-id <repo> --file-format <format>`.
- Upload tmux startup is registered before SSH deployment and returns without waiting for every server. Queued starts remain in SQLite and are retried by reconciliation after a monitor restart; once a remote tmux is running, restarting only Server Monitor does not interrupt it. Restarting the remote solver server or losing that tmux interrupts the operation and leaves retained files available for Retry.
- Upload reports persist incremental per-folder and per-format counts for files found, uploaded, deleted locally, and remaining. Successful `upload.py` calls delete the uploaded local format; the report keeps upload and cleanup outcomes distinct. Operations started by an older build are still observable by comparing their persisted upload plan with files remaining on disk.
- While the Server Operations tab is open and any operation is active, the client requests lightweight operation-only reconciliation every 10 seconds. The upload panel shows aggregate folder/server progress, and each server detail separates completed, current, pending, and failed folders without blocking unrelated controls.
- Upload uses `HF_TOKEN` only on the backend/remote command path. Frontend command previews redact it as `export HF_TOKEN=$HF_TOKEN`.
- Operation records persist command, tmux session, log path, status, and structured result JSON. The UI summarizes sync latest/synced/failed counts and upload success/failed/no-file/file counts.
- Reading the operation report is database-only and never blocks page rendering on SSH. Background/manual reconciliation probes both the remote status file and tmux session; stale active records are marked failed after a server restart, and overlapping reconciliation ticks share one in-flight run.

## API Shape

Representative backend endpoints:

- `GET /api/overview`: latest aggregate status, overall description, latest server rows.
- `GET /api/servers`: server inventory.
- `GET /api/servers/:id`: server metadata and latest snapshot.
- `GET /api/servers/:id/history?hours=24`: per-server historical series.
- `POST /api/refresh`: trigger all-server refresh.
- `GET /api/refresh/current`: report whether a refresh is active.
- `GET /api/settings/alerts`: alert settings and runtime status.
- `PATCH /api/settings/alerts`: update alert settings.
- `POST /api/settings/alerts/test`: send a test alert.
- `GET /api/settings/wechat/accounts`: list WeChat ClawBot recipient accounts and delivery state.
- `POST /api/settings/wechat/accounts`: create a recipient and start QR login.
- `POST /api/settings/wechat/accounts/:accountId/verify`: verify a target user from detected inbound messages.
- `DELETE /api/parallel-jobs/failure-pool?rangePath=<path>&datasetName=<dataset>`: clear pending/failed failure-pool entries for one exact Range/Dataset without stopping parallel runs.
- `DELETE /api/parallel-jobs/:id`: delete an unlocked queued run or permanently delete one terminal history run and its linked jobs, slices, events, and failure-pool entries.
- `GET /api/server-operations`: list server operation records and events.
- `GET /api/server-operations/upload-candidates`: scan all SSH-ready servers for retained result folders.
- `DELETE /api/server-operations/upload-candidates`: validate and delete one remote `results/<dataset>/<job-id>` directory.
- `DELETE /api/server-operations/upload-candidates/bulk`: validate and delete selected Range result directories, serializing work per server and returning per-directory success/failure results.
- `POST /api/server-operations/sync`: start sync tmux sessions for online enabled servers.
- `POST /api/server-operations/network-sync`: update Mihomo and restart network tmux sessions for online enabled servers.
- `POST /api/server-operations/upload`: scan and start upload tmux sessions for online enabled servers.
- `GET /api/server-operations?reconcile=1`: return persisted operation inventory immediately and trigger a deduplicated background SSH status reconciliation.
- `POST /api/server-operations/:id/stop`: stop one operation tmux session.

The first version did not need API routes for editing server inventory. The current app includes a visual server inventory manager that syncs supported editable fields back to `config/servers.json`. Credentials stay out of the inventory and out of the frontend.

## Error Handling

- Manual refresh during an active refresh returns a clear `refresh_in_progress` response.
- Per-server SSH failures are stored as metric snapshots with failure status and error information.
- Backend startup should fail clearly if required SSH credentials are missing.
- Frontend should show stale data with last collection time rather than blanking the dashboard during refresh.
- Frontend should show `unknown` for servers that have never been collected.

## Testing

Implementation should include focused tests for:

- SSH command output parsing.
- Status calculation and threshold handling.
- Refresh locking behavior.
- 24-hour history pruning.
- API response shape.
- Overview and detail page rendering with online, warning, offline, and unknown states.

## Original Out Of Scope For First Version

- Importing Termius data directly.
- Public or LAN access.
- User login.
- Per-server SSH credentials.
- SSH key authentication.
- Network throughput metrics.
- Top process lists.
- Long-term retention beyond 24 hours.
- Alert notifications.
- Server inventory editor UI.
- Per-server manual refresh.

Several original out-of-scope items are now implemented as product extensions, including WeChat alert notifications and a server inventory editor UI.
