# Server Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript server monitoring dashboard with SSH collection, SQLite-backed 24-hour history, overview UI, and per-server detail UI.

**Architecture:** Use a single npm workspace-style package with a TypeScript Express backend under `src/server`, shared contracts under `src/shared`, and a React/Vite frontend under `src/client`. The backend loads server inventory from `config/servers.json`, reads SSH credentials from `.env`, stores snapshots in a local SQLite database file via `sql.js`, and exposes JSON APIs consumed by the frontend.

**Tech Stack:** TypeScript, Node.js, Express, ssh2, sql.js, React, Vite, Vitest, Testing Library, Supertest, lucide-react.

---

## File Structure

- `package.json`: scripts and dependencies for backend, frontend, tests, and dev server.
- `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `vitest.config.ts`: TypeScript, Vite, and test configuration.
- `.env.example`: documents required SSH and optional runtime settings.
- `config/servers.example.json`: sample server inventory.
- `config/servers.json`: local editable server inventory with placeholder rows.
- `src/shared/types.ts`: shared server, metric, status, API response, and refresh types.
- `src/server/config.ts`: environment and inventory loading.
- `src/server/db.ts`: SQLite schema, persistence, pruning, and query methods.
- `src/server/metrics.ts`: parser and status calculation.
- `src/server/sshCollector.ts`: SSH command execution and failure normalization.
- `src/server/refreshService.ts`: refresh locking, parallel collection, run summaries, and scheduling.
- `src/server/api.ts`: Express route construction.
- `src/server/index.ts`: backend entrypoint and static frontend serving in production.
- `src/client/main.tsx`: React entrypoint.
- `src/client/App.tsx`: routing, data fetching, overview and detail screens.
- `src/client/styles.css`: dashboard visual system.
- `src/client/test-utils.tsx`: React test helper.
- `src/**/*.test.ts`, `src/**/*.test.tsx`: focused unit/API/render tests.

## Tasks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `config/servers.example.json`
- Create: `config/servers.json`
- Modify: `.gitignore`

- [ ] Create the npm/Vite/TypeScript scaffold and scripts.
- [ ] Install dependencies with `npm install`.
- [ ] Run `npm run typecheck`; expected initial failures only if source files are not present yet.
- [ ] Commit scaffold after the first passing typecheck.

### Task 2: Shared Types

**Files:**
- Create: `src/shared/types.ts`
- Test: `src/shared/types.test.ts`

- [ ] Define `ServerConfig`, `MetricSnapshot`, `ServerStatus`, `OverviewResponse`, `ServerDetailResponse`, `RefreshState`, and `RefreshRun`.
- [ ] Add a small type-level/runtime fixture test to ensure expected status values are stable.
- [ ] Run `npm test -- src/shared/types.test.ts`; expected pass.
- [ ] Commit shared contracts.

### Task 3: Metrics Parser And Status Rules

**Files:**
- Create: `src/server/metrics.ts`
- Test: `src/server/metrics.test.ts`

- [ ] Write tests for parsing the collector payload.
- [ ] Write tests for `online`, `warning`, `offline`, and `unknown` status calculation.
- [ ] Implement `parseCollectorOutput`, `calculateStatus`, and `buildFailureSnapshot`.
- [ ] Run `npm test -- src/server/metrics.test.ts`; expected pass.
- [ ] Commit parser and status logic.

### Task 4: SQLite Persistence

**Files:**
- Create: `src/server/db.ts`
- Test: `src/server/db.test.ts`

- [ ] Write tests for schema initialization, server upsert from config, snapshot insert, latest overview query, server history query, refresh run insert, and 24-hour pruning.
- [ ] Implement a `MonitorDatabase` class backed by `sql.js`.
- [ ] Use file persistence for normal runtime and in-memory persistence for tests.
- [ ] Run `npm test -- src/server/db.test.ts`; expected pass.
- [ ] Commit persistence layer.

### Task 5: Config Loader

**Files:**
- Create: `src/server/config.ts`
- Test: `src/server/config.test.ts`

- [ ] Write tests for loading `config/servers.json`, validating unique ids, defaulting port to `22`, defaulting enabled to `true`, and failing when SSH credentials are missing.
- [ ] Implement environment loading with `dotenv`.
- [ ] Run `npm test -- src/server/config.test.ts`; expected pass.
- [ ] Commit config loader.

### Task 6: SSH Collector

**Files:**
- Create: `src/server/sshCollector.ts`
- Test: `src/server/sshCollector.test.ts`

- [ ] Write tests with an injected SSH executor for success, auth failure, connection failure, timeout, and parse failure.
- [ ] Implement `collectServerMetrics` using `ssh2` for real execution and the metrics parser for normalization.
- [ ] Use a single shell command that prints key-value lines for CPU, memory, disk, load, and uptime.
- [ ] Run `npm test -- src/server/sshCollector.test.ts`; expected pass.
- [ ] Commit SSH collector.

### Task 7: Refresh Service And Scheduler

**Files:**
- Create: `src/server/refreshService.ts`
- Test: `src/server/refreshService.test.ts`

- [ ] Write tests for parallel collection, refresh locking, summary counts, pruning after refresh, and hourly scheduling hook.
- [ ] Implement `RefreshService` with `refreshAll(trigger)`, `getState()`, and `startScheduler()`.
- [ ] Return `refresh_in_progress` without starting a second run when refresh is active.
- [ ] Run `npm test -- src/server/refreshService.test.ts`; expected pass.
- [ ] Commit refresh service.

### Task 8: API Routes

**Files:**
- Create: `src/server/api.ts`
- Create: `src/server/index.ts`
- Test: `src/server/api.test.ts`

- [ ] Write Supertest tests for `GET /api/overview`, `GET /api/servers`, `GET /api/servers/:id`, `GET /api/servers/:id/history?hours=24`, `POST /api/refresh`, and `GET /api/refresh/current`.
- [ ] Implement Express app construction with dependency injection for tests.
- [ ] Add backend entrypoint that initializes config, database, refresh service, scheduler, and API.
- [ ] Run `npm test -- src/server/api.test.ts`; expected pass.
- [ ] Commit API layer.

### Task 9: React Dashboard

**Files:**
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`
- Create: `src/client/test-utils.tsx`
- Test: `src/client/App.test.tsx`

- [ ] Write render tests for overview macro cards, overall description, server list rows, manual refresh disabled state, detail route, history charts, and error states.
- [ ] Implement API client helpers inside `App.tsx` or small local functions.
- [ ] Implement the overview route and detail route.
- [ ] Use CSS grid/table layout and lightweight inline SVG charts.
- [ ] Run `npm test -- src/client/App.test.tsx`; expected pass.
- [ ] Commit frontend dashboard.

### Task 10: Build, Verification, And Run

**Files:**
- Modify: `README.md`

- [ ] Add a README with setup, `.env`, `config/servers.json`, dev commands, and production run commands.
- [ ] Run `npm run typecheck`; expected pass.
- [ ] Run `npm test -- --run`; expected pass.
- [ ] Run `npm run build`; expected pass.
- [ ] Start the local dev server and verify the dashboard URL opens.
- [ ] Commit docs and final integration.

## Self-Review

- Spec coverage: all confirmed requirements map to tasks 1-10.
- Placeholder scan: no `TODO` or `TBD` entries should remain in implementation files; tests must lock down behavior.
- Type consistency: shared API contracts in `src/shared/types.ts` are the source of truth for backend and frontend.
