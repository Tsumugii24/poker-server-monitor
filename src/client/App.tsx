import {
  Activity,
  ArrowLeft,
  Clock,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Moon,
  RefreshCw,
  Server,
  ShieldCheck,
  Signal,
  Sun,
  TriangleAlert
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConnectionStatus,
  HealthLevel,
  MetricSnapshot,
  OverviewResponse,
  ServerDetailResponse,
  ServerConfig,
  ServerRow
} from "../shared/types";
import "./styles.css";

type Route =
  | { name: "overview" }
  | {
      name: "detail";
      id: string;
    };

type Theme = "dark" | "light";
type SortDirection = "asc" | "desc";

const THEME_KEY = "server-monitor-theme";

/** Read the saved theme from localStorage, falling back to "dark". */
function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Map of metric label → lucide icon for the KPI cards. */
const METRIC_ICONS: Record<string, ReactNode> = {
  Online:       <Signal size={18} />,
  "Avg CPU":    <Cpu size={18} />,
  "Avg Memory": <MemoryStick size={18} />,
  "Avg Disk":   <HardDrive size={18} />,
  CPU:          <Cpu size={18} />,
  Memory:       <MemoryStick size={18} />,
  Disk:         <HardDrive size={18} />,
  Load:         <Gauge size={18} />,
  Uptime:       <Clock size={18} />
};

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [detail, setDetail] = useState<ServerDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const endpoint = route.name === "overview" ? "/api/overview" : `/api/servers/${route.id}`;
    void fetchJson<OverviewResponse | ServerDetailResponse>(endpoint)
      .then((data) => {
        if (route.name === "overview") setOverview(data as OverviewResponse);
        else setDetail(data as ServerDetailResponse);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [route]);

  const openServer = (serverId: string) => {
    window.history.pushState({}, "", `/servers/${serverId}`);
    setRoute({ name: "detail", id: serverId });
  };

  const openOverview = () => {
    window.history.pushState({}, "", "/");
    setRoute({ name: "overview" });
  };

  const refreshAll = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await fetchJson("/api/refresh", { method: "POST" });
      const data = await fetchJson<OverviewResponse>("/api/overview");
      setOverview(data);
      if (route.name === "detail") {
        setDetail(await fetchJson<ServerDetailResponse>(`/api/servers/${route.id}`));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshing(false);
    }
  };

  const renameServer = async (serverId: string, name: string) => {
    const updated = await fetchJson<ServerConfig>(`/api/servers/${encodeURIComponent(serverId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });

    setOverview((current) =>
      current
        ? {
            ...current,
            servers: current.servers.map((server) =>
              server.id === serverId ? { ...server, name: updated.name } : server
            )
          }
        : current
    );
    setDetail((current) =>
      current && current.server.id === serverId
        ? { ...current, server: { ...current.server, name: updated.name } }
        : current
    );
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-logo">
            <ShieldCheck size={22} color="#fff" />
          </div>
          <div className="topbar-text">
            <p className="eyebrow">SSH Infrastructure</p>
            <h1>Server Monitor</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button primary" onClick={refreshAll} disabled={refreshing}>
            <RefreshCw size={16} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <div className="notice">Loading…</div> : null}

      {!loading && route.name === "overview" && overview ? (
        <OverviewView overview={overview} onOpenServer={openServer} onRenameServer={renameServer} />
      ) : null}

      {!loading && route.name === "detail" && detail ? (
        <DetailView detail={detail} onBack={openOverview} />
      ) : null}
    </main>
  );
}

/* ── Overview page ────────────────────────────────────────────── */

function OverviewView({
  overview,
  onOpenServer,
  onRenameServer
}: {
  overview: OverviewResponse;
  onOpenServer: (serverId: string) => void;
  onRenameServer: (serverId: string, name: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [idSortDirection, setIdSortDirection] = useState<SortDirection>("asc");

  const filteredServers = useMemo(() => {
    const servers = overview.servers.filter((server) => {
      const conn = server.latest?.connectionStatus;
      const health = server.latest?.healthLevel;
      if (filter === "all") return true;
      if (filter === "online") return conn === "online";
      if (filter === "offline") return conn === "offline";
      if (filter === "unknown") return conn === "unknown";
      if (filter === "warning") return health === "warning";
      if (filter === "dangerous") return health === "dangerous";
      return true;
    });

    return [...servers].sort((a, b) => {
      const result = a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
      return idSortDirection === "asc" ? result : -result;
    });
  }, [overview.servers, filter, idSortDirection]);

  const toggleIdSort = () => {
    setIdSortDirection((current) => (current === "asc" ? "desc" : "asc"));
  };

  const overallTimestamps = overview.overallHistory.map((p) => p.collectedAt);

  return (
    <>
      <section className="section-heading">
        <div>
          <h2>Dashboard Overview</h2>
          <p>Last refreshed: {formatDate(overview.refresh.lastRun?.finishedAt ?? overview.generatedAt)}</p>
        </div>
        <p>Next auto-refresh: {formatDate(overview.refresh.nextRefreshAt)}</p>
      </section>

      <section className="macro-grid">
        <MetricCard label="Online" value={`${overview.summary.online} / ${overview.summary.total}`} />
        <MetricCard label="Avg CPU" value={formatPercent(overview.summary.averageCpu)} />
        <MetricCard label="Avg Memory" value={formatPercent(overview.summary.averageMemory)} />
        <MetricCard label="Avg Disk" value={formatPercent(overview.summary.averageDisk)} />
      </section>

      <section className="overview-layout">
        <div className="panel">
          <div className="panel-title">
            <Activity size={16} />
            <h3>Overall Trends Within 24 Hours</h3>
          </div>
          <TrendChart
            series={[
              { label: "CPU", color: "var(--chart-cpu)", values: overview.overallHistory.map((p) => p.averageCpu) },
              { label: "Memory", color: "var(--chart-memory)", values: overview.overallHistory.map((p) => p.averageMemory) },
              { label: "Disk", color: "var(--chart-disk)", values: overview.overallHistory.map((p) => p.averageDisk) }
            ]}
            timestamps={overallTimestamps}
            unit="%"
          />
        </div>

        <div className="panel description-panel">
          <div className="panel-title">
            <TriangleAlert size={16} />
            <h3>Health Summary</h3>
          </div>
          <p>{overview.description}</p>
          <dl className="health-tags">
            <div className={`stat-all ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
              <dt>All Servers</dt>
              <dd className="dd-value">{overview.summary.total ?? 0}</dd>
            </div>
            <div className={`stat-online ${filter === "online" ? "active" : ""}`} onClick={() => setFilter("online")}>
              <dt>Online</dt>
              <dd className="dd-value">{overview.summary.online ?? 0}</dd>
            </div>
            <div className={`stat-offline ${filter === "offline" ? "active" : ""}`} onClick={() => setFilter("offline")}>
              <dt>Offline</dt>
              <dd className="dd-value">{overview.summary.offline ?? 0}</dd>
            </div>
            <div className={`stat-unknown ${filter === "unknown" ? "active" : ""}`} onClick={() => setFilter("unknown")}>
              <dt>Unknown</dt>
              <dd className="dd-value">{overview.summary.unknown ?? 0}</dd>
            </div>
            <div className={`stat-warning ${filter === "warning" ? "active" : ""}`} onClick={() => setFilter("warning")}>
              <dt>Warning</dt>
              <dd className="dd-value">{overview.summary.warning ?? 0}</dd>
            </div>
            <div className={`stat-dangerous ${filter === "dangerous" ? "active" : ""}`} onClick={() => setFilter("dangerous")}>
              <dt>Dangerous</dt>
              <dd className="dd-value">{overview.summary.dangerous ?? 0}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <Server size={16} />
          <h3>Server Inventory {filter !== "all" && <span className="inventory-filter-badge">({filteredServers.length})</span>}</h3>
        </div>
        <ServerTable
          servers={filteredServers}
          idSortDirection={idSortDirection}
          onToggleIdSort={toggleIdSort}
          onOpenServer={onOpenServer}
          onRenameServer={onRenameServer}
        />
      </section>
    </>
  );
}

/* ── Detail page ──────────────────────────────────────────────── */

function DetailView({ detail, onBack }: { detail: ServerDetailResponse; onBack: () => void }) {
  const latest = detail.latest;
  const timestamps = detail.history.map((item) => item.collectedAt);

  return (
    <>
      <button className="icon-button ghost" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to Overview
      </button>
      <section className="section-heading detail-heading">
        <div>
          <h2>{detail.server.name} Details</h2>
          <p>{detail.server.host}:{detail.server.port}</p>
        </div>
        <div className="detail-badges">
          <ConnBadge status={latest?.connectionStatus ?? "unknown"} />
          {latest?.connectionStatus === "online" && latest?.healthLevel ? (
            <HealthBadge level={latest.healthLevel} />
          ) : null}
        </div>
      </section>

      <section className="macro-grid five">
        <MetricCard 
          label="CPU" 
          value={formatPercent(latest?.cpuUsedPercent)} 
          subtext={latest?.cpuModel ? `${latest.cpuVcores} vCPUs • ${latest.cpuModel}` : undefined}
        />
        <MetricCard 
          label="Memory" 
          value={formatPercent(latest?.memoryUsedPercent)} 
          subtext={latest?.memoryTotalBytes ? `${formatBytes(latest.memoryUsedBytes)} / ${formatBytes(latest.memoryTotalBytes)}` : undefined}
        />
        <MetricCard 
          label="Disk" 
          value={formatPercent(latest?.diskUsedPercent)} 
          subtext={latest?.diskTotalBytes ? `${formatBytes(latest.diskUsedBytes)} / ${formatBytes(latest.diskTotalBytes)}` : undefined}
        />
        <MetricCard label="Load" value={latest?.load1?.toFixed(2) ?? "-"} />
        <MetricCard label="Uptime" value={formatDuration(latest?.uptimeSeconds)} />
      </section>

      {latest?.errorMessage ? <div className="notice error">{latest.errorMessage}</div> : null}

      <section className="detail-grid">
        <ChartPanel title="CPU 24h" icon={<Cpu size={16} />} values={detail.history.map((i) => i.cpuUsedPercent)} color="var(--chart-cpu)" timestamps={timestamps} unit="%" />
        <ChartPanel title="Memory 24h" icon={<MemoryStick size={16} />} values={detail.history.map((i) => i.memoryUsedPercent)} color="var(--chart-memory)" timestamps={timestamps} unit="%" />
        <ChartPanel title="Disk 24h" icon={<HardDrive size={16} />} values={detail.history.map((i) => i.diskUsedPercent)} color="var(--chart-disk)" timestamps={timestamps} unit="%" />
        <ChartPanel title="Load 24h" icon={<Gauge size={16} />} values={detail.history.map((i) => i.load1)} color="var(--chart-load)" timestamps={timestamps} unit="" />
      </section>
    </>
  );
}

/* ── Shared components ────────────────────────────────────────── */

function MetricCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
  const icon = METRIC_ICONS[label];
  return (
    <div className="metric-card">
      <div className="metric-card-header">
        {icon ? <span className="metric-card-icon">{icon}</span> : null}
        <span className="metric-card-label">{label}</span>
      </div>
      <strong>{value}</strong>
      {subtext ? <span className="metric-card-subtext" title={subtext}>{subtext}</span> : null}
    </div>
  );
}

function ServerTable({
  servers,
  idSortDirection,
  onToggleIdSort,
  onOpenServer,
  onRenameServer
}: {
  servers: ServerRow[];
  idSortDirection: SortDirection;
  onToggleIdSort: () => void;
  onOpenServer: (serverId: string) => void;
  onRenameServer: (serverId: string, name: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  const startEditing = (server: ServerRow) => {
    setEditingId(server.id);
    setDraftName(server.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraftName("");
  };

  const commitName = async (server: ServerRow) => {
    const nextName = draftName.trim();
    if (nextName === "" || nextName === server.name) {
      cancelEditing();
      return;
    }

    setSavingId(server.id);
    try {
      await onRenameServer(server.id, nextName);
      cancelEditing();
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th aria-label="ID">
              <button
                className="table-sort-button"
                onClick={onToggleIdSort}
                aria-label={`Sort by ID ${idSortDirection === "asc" ? "descending" : "ascending"}`}
                title={`Sort by ID ${idSortDirection === "asc" ? "descending" : "ascending"}`}
              >
                ID
                <span aria-hidden="true">{idSortDirection === "asc" ? "↑" : "↓"}</span>
              </button>
            </th>
            <th>Name</th>
            <th>Port</th>
            <th>Status</th>
            <th>Health</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Disk</th>
            <th>Load</th>
            <th>Uptime</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <tr key={server.id} onClick={() => onOpenServer(server.id)}>
              <td>
                <span className="server-id-value">{server.id}</span>
              </td>
              <td>
                {editingId === server.id ? (
                  <input
                    className="server-name-input"
                    aria-label={`Server name for ${server.id}`}
                    value={draftName}
                    disabled={savingId === server.id}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={() => void commitName(server)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        cancelEditing();
                      }
                    }}
                  />
                ) : (
                  <button
                    className="row-button"
                    aria-label={`Edit name for ${server.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      startEditing(server);
                    }}
                  >
                    {server.name}
                  </button>
                )}
                <span className="muted">{server.host}</span>
              </td>
              <td>
                <span className="port-value">{server.port}</span>
              </td>
              <td>
                <ConnBadge status={server.latest?.connectionStatus ?? "unknown"} />
              </td>
              <td>
                {server.latest?.connectionStatus === "online" && server.latest?.healthLevel ? (
                  <HealthBadge level={server.latest.healthLevel} />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td>{formatPercent(server.latest?.cpuUsedPercent)}</td>
              <td>{formatPercent(server.latest?.memoryUsedPercent)}</td>
              <td>{formatPercent(server.latest?.diskUsedPercent)}</td>
              <td>{server.latest?.load1?.toFixed(2) ?? "-"}</td>
              <td>{formatDuration(server.latest?.uptimeSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Connection status badge — shows online / offline / unknown. */
function ConnBadge({ status }: { status: ConnectionStatus }) {
  return <span className={`badge conn-badge ${status}`}>{status}</span>;
}

/** Health level badge — shows healthy / warning / dangerous. */
function HealthBadge({ level }: { level: HealthLevel }) {
  return <span className={`badge health-badge ${level}`}>{level}</span>;
}

function ChartPanel({
  title,
  icon,
  values,
  color,
  timestamps,
  unit
}: {
  title: string;
  icon?: ReactNode;
  values: Array<number | null>;
  color: string;
  timestamps?: string[];
  unit?: string;
}) {
  return (
    <div className="panel">
      <div className="panel-title">
        {icon}
        <h3>{title}</h3>
      </div>
      <TrendChart series={[{ label: title, values, color }]} timestamps={timestamps} unit={unit} />
    </div>
  );
}

/* ── Chart ────────────────────────────────────────────────────── */
const CHART_W = 620;
const CHART_H = 220;
const PAD_L = 48;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 32;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

function TrendChart({
  series,
  timestamps,
  unit = "%"
}: {
  series: Array<{ label: string; values: Array<number | null>; color: string }>;
  timestamps?: string[];
  unit?: string;
}) {
  const { paths, yTicks, xTicks, gradientDefs } = useMemo(() => {
    const allValues = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    if (allValues.length === 0) return { paths: [], yTicks: [], xTicks: [], gradientDefs: [] };

    const rawMax = Math.max(...allValues);
    const dataMax = unit === "%" ? Math.max(100, rawMax) : niceMax(rawMax);

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
      value: Math.round(dataMax * (1 - frac)),
      y: PAD_T + frac * PLOT_H
    }));

    const xTicks: Array<{ label: string; x: number }> = [];
    if (timestamps && timestamps.length > 1) {
      const count = Math.min(6, timestamps.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.round((i / (count - 1)) * (timestamps.length - 1));
        xTicks.push({ label: formatTimeLabel(timestamps[idx]!), x: chartX(idx, timestamps.length) });
      }
    } else if (timestamps && timestamps.length === 1) {
      xTicks.push({ label: formatTimeLabel(timestamps[0]!), x: chartX(0, 1) });
    }

    const paths = series.map((item, i) => ({
      ...item,
      d: makeChartPath(item.values, dataMax),
      fillD: makeChartFillPath(item.values, dataMax),
      points: makeChartPoints(item.values, dataMax),
      gradId: `grad-${i}`
    }));

    return {
      paths,
      yTicks,
      xTicks,
      gradientDefs: paths.map((p) => ({ id: p.gradId, color: p.color }))
    };
  }, [series, timestamps, unit]);

  if (paths.length === 0 || paths.every((p) => p.d === "")) {
    return <div className="empty-chart">No historical data available</div>;
  }

  return (
    <>
      <svg className="chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" preserveAspectRatio="xMidYMid meet">
        <defs>
          {gradientDefs.map((g) => (
            <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={g.color} stopOpacity="0.25" />
              <stop offset="100%" stopColor={g.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {yTicks.map((t) => (
          <g key={t.value}>
            <line className="chart-grid" x1={PAD_L} y1={t.y} x2={CHART_W - PAD_R} y2={t.y} />
            <text className="chart-axis-label chart-y-label" x={PAD_L - 8} y={t.y + 4} textAnchor="end">{t.value}{unit}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="chart-axis-label chart-x-label" x={t.x} y={CHART_H - 6} textAnchor="middle">{t.label}</text>
        ))}
        {paths.map((p) => p.fillD ? <path key={`fill-${p.label}`} d={p.fillD} fill={`url(#${p.gradId})`} /> : null)}
        {paths.map((p) => <path key={p.label} d={p.d} stroke={p.color} />)}
        {paths.flatMap((p) =>
          p.points.map((point) => (
            <circle
              key={`${p.label}-${point.index}`}
              className="chart-point"
              cx={point.x}
              cy={point.y}
              r="3.5"
              fill={p.color}
            />
          ))
        )}
      </svg>
      {series.length > 1 ? (
        <div className="chart-legend">
          {series.map((s) => (
            <div key={s.label} className="chart-legend-item">
              <span className="chart-legend-swatch" style={{ background: s.color }} />
              {s.label}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/* ── Chart path helpers ───────────────────────────────────────── */

function makeChartPath(values: Array<number | null>, max: number): string {
  const numeric = values.filter((v): v is number => v !== null);
  if (numeric.length === 0) return "";
  return values
    .map((value, index) => {
      if (value === null) return null;
      const x = chartX(index, values.length);
      const y = PAD_T + (1 - value / max) * PLOT_H;
      return `${index === 0 || values[index - 1] === null ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function makeChartPoints(values: Array<number | null>, max: number): Array<{ index: number; x: number; y: number }> {
  return values.flatMap((value, index) => {
    if (value === null) return [];
    return [{
      index,
      x: chartX(index, values.length),
      y: PAD_T + (1 - value / max) * PLOT_H
    }];
  });
}

function makeChartFillPath(values: Array<number | null>, max: number): string {
  if (values.some((value) => value === null)) return "";
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    points.push({
      x: chartX(i, values.length),
      y: PAD_T + (1 - v / max) * PLOT_H
    });
  }
  if (points.length < 2) return "";
  const baseline = PAD_T + PLOT_H;
  let d = `M ${points[0]!.x.toFixed(1)} ${baseline}`;
  for (const p of points) d += ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  d += ` L ${points[points.length - 1]!.x.toFixed(1)} ${baseline} Z`;
  return d;
}

function chartX(index: number, count: number): number {
  return PAD_L + (count <= 1 ? 0 : (index / (count - 1)) * PLOT_W);
}

function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  if (n <= 1) return mag;
  if (n <= 2) return 2 * mag;
  if (n <= 5) return 5 * mag;
  return 10 * mag;
}

/* ── Utility functions ────────────────────────────────────────── */

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}

function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/servers\/([^/]+)$/);
  return match ? { name: "detail", id: decodeURIComponent(match[1]) } : { name: "overview" };
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "-" : `${Math.round(value)}%`;
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function formatTimeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "-";
  if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + " TB";
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}
