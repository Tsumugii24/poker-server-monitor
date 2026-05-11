import { Activity, ArrowLeft, RefreshCw, Server, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  MetricSnapshot,
  OverviewResponse,
  ServerDetailResponse,
  ServerRow,
  ServerStatus
} from "../shared/types";
import "./styles.css";

type Route =
  | { name: "overview" }
  | {
      name: "detail";
      id: string;
    };

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [detail, setDetail] = useState<ServerDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (route.name === "overview") {
          setOverview(data as OverviewResponse);
        } else {
          setDetail(data as ServerDetailResponse);
        }
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local SSH Monitor</p>
          <h1>Server Monitor</h1>
        </div>
        <button className="icon-button primary" onClick={refreshAll} disabled={refreshing}>
          <RefreshCw size={18} />
          {refreshing ? "刷新中" : "刷新"}
        </button>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <div className="notice">加载中...</div> : null}

      {!loading && route.name === "overview" && overview ? (
        <OverviewView overview={overview} onOpenServer={openServer} />
      ) : null}

      {!loading && route.name === "detail" && detail ? (
        <DetailView detail={detail} onBack={openOverview} />
      ) : null}
    </main>
  );
}

function OverviewView({
  overview,
  onOpenServer
}: {
  overview: OverviewResponse;
  onOpenServer: (serverId: string) => void;
}) {
  return (
    <>
      <section className="section-heading">
        <div>
          <h2>整体监控</h2>
          <p>最近刷新：{formatDate(overview.refresh.lastRun?.finishedAt ?? overview.generatedAt)}</p>
        </div>
        <p>下次自动刷新：{formatDate(overview.refresh.nextRefreshAt)}</p>
      </section>

      <section className="macro-grid">
        <MetricCard label="在线" value={`${overview.summary.online} / ${overview.summary.total}`} />
        <MetricCard label="平均 CPU" value={formatPercent(overview.summary.averageCpu)} />
        <MetricCard label="平均内存" value={formatPercent(overview.summary.averageMemory)} />
        <MetricCard label="平均磁盘" value={formatPercent(overview.summary.averageDisk)} />
      </section>

      <section className="overview-layout">
        <div className="panel">
          <div className="panel-title">
            <Activity size={18} />
            <h3>整体 24h 趋势</h3>
          </div>
          <TrendChart
            series={[
              { label: "CPU", color: "#2563eb", values: overview.overallHistory.map((p) => p.averageCpu) },
              {
                label: "Memory",
                color: "#16a34a",
                values: overview.overallHistory.map((p) => p.averageMemory)
              },
              { label: "Disk", color: "#f59e0b", values: overview.overallHistory.map((p) => p.averageDisk) }
            ]}
          />
        </div>

        <div className="panel description-panel">
          <div className="panel-title">
            <TriangleAlert size={18} />
            <h3>整体信息</h3>
          </div>
          <p>{overview.description}</p>
          <dl>
            <div>
              <dt>Warning</dt>
              <dd>{overview.summary.warning}</dd>
            </div>
            <div>
              <dt>Offline</dt>
              <dd>{overview.summary.offline}</dd>
            </div>
            <div>
              <dt>Unknown</dt>
              <dd>{overview.summary.unknown}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <Server size={18} />
          <h3>服务器列表</h3>
        </div>
        <ServerTable servers={overview.servers} onOpenServer={onOpenServer} />
      </section>
    </>
  );
}

function DetailView({ detail, onBack }: { detail: ServerDetailResponse; onBack: () => void }) {
  const latest = detail.latest;
  return (
    <>
      <button className="icon-button ghost" onClick={onBack}>
        <ArrowLeft size={18} />
        返回总览
      </button>
      <section className="section-heading detail-heading">
        <div>
          <h2>{detail.server.name} 详情</h2>
          <p>
            {detail.server.host}:{detail.server.port}
          </p>
        </div>
        <StatusBadge status={latest?.status ?? "unknown"} />
      </section>

      <section className="macro-grid five">
        <MetricCard label="CPU" value={formatPercent(latest?.cpuUsedPercent)} />
        <MetricCard label="内存" value={formatPercent(latest?.memoryUsedPercent)} />
        <MetricCard label="磁盘" value={formatPercent(latest?.diskUsedPercent)} />
        <MetricCard label="Load" value={latest?.load1?.toFixed(2) ?? "-"} />
        <MetricCard label="Uptime" value={formatDuration(latest?.uptimeSeconds)} />
      </section>

      {latest?.errorMessage ? <div className="notice error">{latest.errorMessage}</div> : null}

      <section className="detail-grid">
        <ChartPanel title="CPU 24h" values={detail.history.map((item) => item.cpuUsedPercent)} color="#2563eb" />
        <ChartPanel title="Memory 24h" values={detail.history.map((item) => item.memoryUsedPercent)} color="#16a34a" />
        <ChartPanel title="Disk 24h" values={detail.history.map((item) => item.diskUsedPercent)} color="#f59e0b" />
        <ChartPanel title="Load 24h" values={detail.history.map((item) => item.load1)} color="#9333ea" />
      </section>
    </>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ServerTable({
  servers,
  onOpenServer
}: {
  servers: ServerRow[];
  onOpenServer: (serverId: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
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
                <button className="row-button">{server.name}</button>
                <span className="muted">{server.host}</span>
              </td>
              <td>
                <StatusBadge status={server.latest?.status ?? "unknown"} />
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

function ChartPanel({ title, values, color }: { title: string; values: Array<number | null>; color: string }) {
  return (
    <div className="panel">
      <div className="panel-title">
        <h3>{title}</h3>
      </div>
      <TrendChart series={[{ label: title, values, color }]} />
    </div>
  );
}

function TrendChart({
  series
}: {
  series: Array<{ label: string; values: Array<number | null>; color: string }>;
}) {
  const width = 520;
  const height = 160;
  const paths = useMemo(
    () =>
      series.map((item) => ({
        ...item,
        d: makePath(item.values, width, height)
      })),
    [series]
  );

  if (paths.every((item) => item.d === "")) {
    return <div className="empty-chart">暂无历史数据</div>;
  }

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img">
      <line x1="0" y1={height - 20} x2={width} y2={height - 20} />
      {paths.map((item) => (
        <path key={item.label} d={item.d} stroke={item.color} />
      ))}
    </svg>
  );
}

function StatusBadge({ status }: { status: ServerStatus }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function makePath(values: Array<number | null>, width: number, height: number): string {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return "";
  const max = Math.max(100, ...numeric);
  return values
    .map((value, index) => {
      if (value === null) return null;
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const y = height - 20 - (value / max) * (height - 40);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
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
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}
