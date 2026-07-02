import {
  Activity,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  Gauge,
  Grid3X3,
  HardDrive,
  MemoryStick,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Signal,
  Sun,
  Trash2,
  TriangleAlert,
  Workflow,
  X
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { PreflopRangeView } from "./PreflopRangeView";
import { SettingsWizard } from "./SettingsWizard";
import type {
  AlertSettings,
  AlertStatus,
  ConnectionStatus,
  HealthLevel,
  HfProxyRuntimeStatus,
  MetricSnapshot,
  OverviewResponse,
  PipelineDisplayStatus,
  PipelineStatusSnapshot,
  ServerDetailResponse,
  ServerConfig,
  ServerRow,
  WeChatAccountConnectorStatus,
  WeChatAccountsStatus,
  WeChatConnectorStatus
} from "../shared/types";
import {
  buildWeChatDelivery
} from "../shared/wechatDelivery";
import { defaultWeChatStoredSession } from "../shared/wechatSession";
import "./styles.css";

type Route =
  | { name: "overview" }
  | { name: "inventory" }
  | { name: "preflop" }
  | {
      name: "detail";
      id: string;
    };

type Theme = "dark" | "light";
type SortDirection = "asc" | "desc";

type ServerInventoryCreateInput = {
  host: string;
  port: number;
  group?: string | null;
  enabled: boolean;
  note?: string;
  solverRoot?: string | null;
  tmuxSession?: string | null;
  pipelineStatusFilePath?: string | null;
};

type ServerInventoryUpdatePatch = {
  host?: string;
  port?: number;
  group?: string | null;
  enabled?: boolean;
  note?: string;
  solverRoot?: string | null;
  tmuxSession?: string | null;
  pipelineStatusFilePath?: string | null;
};

type ServerInventoryDraft = {
  host: string;
  port: string;
  group: string;
  enabled: boolean;
  note: string;
  solverRoot: string;
  tmuxSession: string;
  pipelineStatusFilePath: string;
};

type AlertSettingsResponse = {
  settings: AlertSettings;
  status: AlertStatus;
  hfProxy: HfProxyRuntimeStatus;
};

type WeChatAccountMutationResponse = {
  account?: WeChatAccountConnectorStatus;
  settings?: AlertSettings;
  status?: AlertStatus;
  wechatAccounts: WeChatAccountsStatus;
};

const EMPTY_WECHAT_STATUS: WeChatConnectorStatus = {
  started: false,
  loggedIn: false,
  polling: false,
  ready: false,
  qrUrl: null,
  awaitingQr: false,
  botUserId: null,
  storedSession: defaultWeChatStoredSession(),
  lastError: null,
  messageCount: 0,
  lastMessageAt: null,
  recentChats: [],
  target: null,
  delivery: buildWeChatDelivery({
    alertsConfigured: false,
    started: false,
    loggedIn: false,
    polling: false,
    ready: false,
    qrUrl: null,
    awaitingQr: false,
    lastError: null,
    target: null
  })
};

const EMPTY_WECHAT_ACCOUNTS_STATUS: WeChatAccountsStatus = {
  accounts: [],
  activeLoginAccountId: null,
  enabledCount: 0,
  verifiedCount: 0
};

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
  Task:           <Workflow size={18} />,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertSettings, setAlertSettings] = useState<AlertSettings | null>(null);
  const [alertStatus, setAlertStatus] = useState<AlertStatus | null>(null);
  const [wechatStatus, setWeChatStatus] = useState<WeChatConnectorStatus>(EMPTY_WECHAT_STATUS);
  const [wechatAccountsStatus, setWeChatAccountsStatus] = useState<WeChatAccountsStatus>(EMPTY_WECHAT_ACCOUNTS_STATUS);
  const [hfProxyStatus, setHfProxyStatus] = useState<HfProxyRuntimeStatus | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  const openSettings = async () => {
    setSettingsOpen(true);
    setError(null);
    try {
      const response = await fetchJson<AlertSettingsResponse>("/api/settings/alerts");
      const [legacyWeChat, accountsWeChat] = await Promise.all([
        fetchJson<WeChatConnectorStatus>("/api/settings/wechat"),
        fetchJson<WeChatAccountsStatus>("/api/settings/wechat/accounts")
      ]);
      setAlertSettings(response.settings);
      setAlertStatus(response.status);
      setHfProxyStatus(response.hfProxy);
      setWeChatStatus(legacyWeChat);
      setWeChatAccountsStatus(accountsWeChat);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveAlertSettings = async (settings: AlertSettings) => {
    setSettingsSaving(true);
    setError(null);
    try {
      const response = await fetchJson<AlertSettingsResponse>("/api/settings/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      setAlertSettings(response.settings);
      setAlertStatus(response.status);
      setHfProxyStatus(response.hfProxy);
      const [legacyWeChat, accountsWeChat] = await Promise.all([
        fetchJson<WeChatConnectorStatus>("/api/settings/wechat"),
        fetchJson<WeChatAccountsStatus>("/api/settings/wechat/accounts")
      ]);
      setWeChatStatus(legacyWeChat);
      setWeChatAccountsStatus(accountsWeChat);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving(false);
    }
  };

  const sendTestAlert = async (settings: AlertSettings) => {
    setSettingsSaving(true);
    setError(null);
    try {
      const response = await fetchJson<{
        status: AlertStatus;
        hfProxy?: HfProxyRuntimeStatus;
        wechat?: WeChatConnectorStatus;
        wechatAccounts?: WeChatAccountsStatus;
      }>(
        "/api/settings/alerts/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings)
        }
      );
      setAlertSettings(settings);
      setAlertStatus(response.status);
      if (response.hfProxy) {
        setHfProxyStatus(response.hfProxy);
      }
      if (response.wechat) {
        setWeChatStatus(response.wechat);
      } else {
        setWeChatStatus(await fetchJson<WeChatConnectorStatus>("/api/settings/wechat"));
      }
      if (response.wechatAccounts) {
        setWeChatAccountsStatus(response.wechatAccounts);
      } else {
        setWeChatAccountsStatus(await fetchJson<WeChatAccountsStatus>("/api/settings/wechat/accounts"));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      try {
        const [legacyWeChat, accountsWeChat] = await Promise.all([
          fetchJson<WeChatConnectorStatus>("/api/settings/wechat"),
          fetchJson<WeChatAccountsStatus>("/api/settings/wechat/accounts")
        ]);
        setWeChatStatus(legacyWeChat);
        setWeChatAccountsStatus(accountsWeChat);
      } catch {
        /* ignore secondary refresh failure */
      }
    } finally {
      setSettingsSaving(false);
    }
  };

  const startWeChatLogin = async () => {
    setSettingsSaving(true);
    setError(null);
    try {
      await fetchJson<{ accepted: boolean }>("/api/settings/wechat/start", { method: "POST" });
      await refreshWeChatStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving(false);
    }
  };

  const refreshWeChatStatus = useCallback(async () => {
    setError(null);
    try {
      setWeChatStatus(await fetchJson<WeChatConnectorStatus>("/api/settings/wechat"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const refreshWeChatQr = async () => {
    setSettingsSaving(true);
    setError(null);
    try {
      await fetchJson<{ accepted: boolean }>("/api/settings/wechat/qr/refresh", { method: "POST" });
      await refreshWeChatStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  };

  const logoutWeChat = async () => {
    setSettingsSaving(true);
    setError(null);
    try {
      setWeChatStatus(await fetchJson<WeChatConnectorStatus>("/api/settings/wechat/logout", { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  };

  const switchWeChatAccount = async () => {
    setSettingsSaving(true);
    setError(null);
    try {
      await fetchJson<{ accepted: boolean }>("/api/settings/wechat/switch", { method: "POST" });
      await refreshWeChatStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  };

  const restoreWeChatSession = async () => {
    setSettingsSaving(true);
    setError(null);
    try {
      setWeChatStatus(await fetchJson<WeChatConnectorStatus>("/api/settings/wechat/restore", { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  };

  const applyWeChatAccountResponse = (response: WeChatAccountMutationResponse) => {
    if (response.settings) {
      setAlertSettings(response.settings);
    }
    if (response.status) {
      setAlertStatus(response.status);
    }
    setWeChatAccountsStatus(response.wechatAccounts);
  };

  const refreshWeChatAccountsStatus = useCallback(async () => {
    setError(null);
    try {
      setWeChatAccountsStatus(await fetchJson<WeChatAccountsStatus>("/api/settings/wechat/accounts"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const createWeChatAccount = async (): Promise<WeChatAccountConnectorStatus | null> => {
    setSettingsSaving(true);
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>("/api/settings/wechat/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      applyWeChatAccountResponse(response);
      return response.account ?? null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateWeChatAccount = async (id: string, patch: { label?: string; enabled?: boolean }) => {
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>(`/api/settings/wechat/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      applyWeChatAccountResponse(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const removeWeChatAccount = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>(`/api/settings/wechat/accounts/${id}`, {
        method: "DELETE"
      });
      applyWeChatAccountResponse(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const refreshWeChatAccountQr = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>(`/api/settings/wechat/accounts/${id}/qr/refresh`, {
        method: "POST"
      });
      applyWeChatAccountResponse(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const restoreWeChatAccount = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>(`/api/settings/wechat/accounts/${id}/restore`, {
        method: "POST"
      });
      applyWeChatAccountResponse(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const logoutWeChatAccount = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>(`/api/settings/wechat/accounts/${id}/logout`, {
        method: "POST"
      });
      applyWeChatAccountResponse(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const verifyWeChatAccount = async (id: string, targetUserId?: string) => {
    setError(null);
    try {
      const response = await fetchJson<WeChatAccountMutationResponse>(`/api/settings/wechat/accounts/${id}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetUserId ? { targetUserId } : {})
      });
      applyWeChatAccountResponse(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const testWeChatAccount = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<{ status: AlertStatus; wechatAccounts?: WeChatAccountsStatus }>(
        `/api/settings/alerts/test/account/${id}`,
        { method: "POST" }
      );
      setAlertStatus(response.status);
      if (response.wechatAccounts) {
        setWeChatAccountsStatus(response.wechatAccounts);
      } else {
        await refreshWeChatAccountsStatus();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const addRecipient = async (contactId: string, label: string) => {
    setError(null);
    try {
      const response = await fetchJson<{ settings: AlertSettings; status: AlertStatus }>(
        "/api/settings/alerts/recipients",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId, label })
        }
      );
      setAlertSettings(response.settings);
      setAlertStatus(response.status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const updateRecipient = async (id: string, patch: { enabled?: boolean; contactId?: string; label?: string }) => {
    setError(null);
    try {
      const response = await fetchJson<{ settings: AlertSettings; status: AlertStatus }>(
        `/api/settings/alerts/recipients/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch)
        }
      );
      setAlertSettings(response.settings);
      setAlertStatus(response.status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const removeRecipient = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<{ settings: AlertSettings; status: AlertStatus }>(
        `/api/settings/alerts/recipients/${id}`,
        { method: "DELETE" }
      );
      setAlertSettings(response.settings);
      setAlertStatus(response.status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const testRecipient = async (id: string) => {
    setError(null);
    try {
      const response = await fetchJson<{ status: AlertStatus; wechat?: WeChatConnectorStatus }>(
        `/api/settings/alerts/test/${id}`,
        { method: "POST" }
      );
      setAlertStatus(response.status);
      if (response.wechat) {
        setWeChatStatus(response.wechat);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  useEffect(() => {
    if (!settingsOpen || wechatStatus.loggedIn) return undefined;
    void refreshWeChatStatus();
    const timer = window.setInterval(() => {
      void refreshWeChatStatus();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [settingsOpen, wechatStatus.loggedIn, refreshWeChatStatus]);

  const shouldPollWeChatAccounts = settingsOpen && wechatAccountsStatus.accounts.some((account) =>
    account.connector.awaitingQr ||
    Boolean(account.connector.qrUrl) ||
    (account.connector.loggedIn && !account.verified)
  );

  useEffect(() => {
    if (!shouldPollWeChatAccounts) return undefined;
    void refreshWeChatAccountsStatus();
    const timer = window.setInterval(() => {
      void refreshWeChatAccountsStatus();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refreshWeChatAccountsStatus, shouldPollWeChatAccounts]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    if (route.name === "preflop") {
      setLoading(false);
      return;
    }
    const endpoint = route.name === "detail" ? `/api/servers/${route.id}` : "/api/overview";
    void fetchJson<OverviewResponse | ServerDetailResponse>(endpoint)
      .then((data) => {
        if (route.name === "detail") setDetail(data as ServerDetailResponse);
        else setOverview(data as OverviewResponse);
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

  const openInventoryManager = () => {
    window.history.pushState({}, "", "/inventory");
    setRoute({ name: "inventory" });
  };

  const openPreflopRanges = () => {
    window.history.pushState({}, "", "/preflop-ranges");
    setRoute({ name: "preflop" });
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

  const reloadOverview = async (): Promise<OverviewResponse> => {
    const data = await fetchJson<OverviewResponse>("/api/overview");
    setOverview(data);
    return data;
  };

  const createServer = async (input: ServerInventoryCreateInput) => {
    setError(null);
    try {
      await fetchJson<ServerConfig>("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      await reloadOverview();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const updateServerInventory = async (serverId: string, patch: ServerInventoryUpdatePatch) => {
    setError(null);
    try {
      const updated = await fetchJson<ServerConfig>(`/api/servers/${encodeURIComponent(serverId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });

      setOverview((current) =>
        current
          ? {
              ...current,
              servers: current.servers.map((server) =>
                server.id === serverId ? { ...server, ...updated } : server
              )
            }
          : current
      );
      setDetail((current) =>
        current && current.server.id === serverId
          ? { ...current, server: { ...current.server, ...updated } }
          : current
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const updateServerNote = async (serverId: string, note: string) => {
    await updateServerInventory(serverId, { note });
  };

  const removeServer = async (serverId: string) => {
    setError(null);
    try {
      await fetchJson<{ servers: ServerConfig[] }>(`/api/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE"
      });
      await reloadOverview();
      if (route.name === "detail" && route.id === serverId) {
        openOverview();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-logo">
            <ShieldCheck size={22} color="#fff" />
          </div>
          <div className="topbar-text">
            <p className="eyebrow">Poker Infrastructure</p>
            <h1>Server Monitor</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className={`icon-button topbar-link-button ${route.name === "preflop" ? "active" : ""}`}
            onClick={openPreflopRanges}
          >
            <Grid3X3 size={16} />
            Ranges
          </button>
          <button
            className="theme-toggle"
            onClick={openSettings}
            title="Open settings"
            aria-label="Open settings"
          >
            <Settings size={18} />
          </button>
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

      {settingsOpen && alertSettings ? (
        <div className="modal-backdrop" role="presentation">
          <SettingsWizard
            settings={alertSettings}
            status={alertStatus}
            hfProxyStatus={hfProxyStatus}
            saving={settingsSaving}
            onClose={() => setSettingsOpen(false)}
            onSave={saveAlertSettings}
            onTest={sendTestAlert}
            wechatAccountsStatus={wechatAccountsStatus}
            onCreateWeChatAccount={createWeChatAccount}
            onRefreshWeChatAccounts={refreshWeChatAccountsStatus}
            onRefreshWeChatAccountQr={refreshWeChatAccountQr}
            onRestoreWeChatAccount={restoreWeChatAccount}
            onLogoutWeChatAccount={logoutWeChatAccount}
            onUpdateWeChatAccount={updateWeChatAccount}
            onRemoveWeChatAccount={removeWeChatAccount}
            onVerifyWeChatAccount={verifyWeChatAccount}
            onTestWeChatAccount={testWeChatAccount}
          />
        </div>
      ) : null}

      {!loading && route.name === "overview" && overview ? (
        <OverviewView
          overview={overview}
          onOpenServer={openServer}
          onManageInventory={openInventoryManager}
          onUpdateServerNote={updateServerNote}
        />
      ) : null}

      {!loading && route.name === "inventory" && overview ? (
        <InventoryManageView
          servers={overview.servers}
          onBack={openOverview}
          onCreateServer={createServer}
          onUpdateServer={updateServerInventory}
          onRemoveServer={removeServer}
        />
      ) : null}

      {!loading && route.name === "preflop" ? (
        <PreflopRangeView onBack={openOverview} />
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
  onManageInventory,
  onUpdateServerNote
}: {
  overview: OverviewResponse;
  onOpenServer: (serverId: string) => void;
  onManageInventory: () => void;
  onUpdateServerNote: (serverId: string, note: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [idSortDirection, setIdSortDirection] = useState<SortDirection>("asc");
  const [pageSize, setPageSize] = useState(10);
  const [pageIndex, setPageIndex] = useState(0);

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
      if (filter === "task-running") return isTaskActive(server.pipeline);
      if (filter === "task-stale") return server.pipeline?.displayStatus === "stale";
      return true;
    });

    return [...servers].sort((a, b) => {
      const result = a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
      return idSortDirection === "asc" ? result : -result;
    });
  }, [overview.servers, filter, idSortDirection]);

  const pageCount = Math.max(1, Math.ceil(filteredServers.length / pageSize));
  const currentPageIndex = Math.min(pageIndex, pageCount - 1);
  const pagedServers = useMemo(() => {
    const start = currentPageIndex * pageSize;
    return filteredServers.slice(start, start + pageSize);
  }, [currentPageIndex, filteredServers, pageSize]);

  useEffect(() => {
    setPageIndex(0);
  }, [filter, idSortDirection, pageSize]);

  useEffect(() => {
    if (pageIndex > pageCount - 1) {
      setPageIndex(pageCount - 1);
    }
  }, [pageCount, pageIndex]);

  const toggleIdSort = () => {
    setPageIndex(0);
    setIdSortDirection((current) => (current === "asc" ? "desc" : "asc"));
  };

  const resultStart = filteredServers.length === 0 ? 0 : currentPageIndex * pageSize + 1;
  const resultEnd = filteredServers.length === 0 ? 0 : resultStart + pagedServers.length - 1;

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

      <section className="macro-grid five">
        <MetricCard label="Online" value={`${overview.summary.online} / ${overview.summary.total}`} />
        <MetricCard
          label="Task"
          value={`${overview.summary.pipelineRunning} running`}
          subtext={
            overview.summary.pipelineStale > 0
              ? `${overview.summary.pipelineStale} stale`
              : `${overview.summary.pipelineIdle} idle`
          }
        />
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
            <div className={`stat-task ${filter === "task-running" ? "active" : ""}`} onClick={() => setFilter("task-running")}>
              <dt>Task Running</dt>
              <dd className="dd-value">{overview.summary.pipelineRunning ?? 0}</dd>
            </div>
            <div className={`stat-task-stale ${filter === "task-stale" ? "active" : ""}`} onClick={() => setFilter("task-stale")}>
              <dt>Task Stale</dt>
              <dd className="dd-value">{overview.summary.pipelineStale ?? 0}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title inventory-panel-title">
          <div className="panel-title-main">
            <Server size={16} />
            <h3>Server Inventory {filter !== "all" && <span className="inventory-filter-badge">({filteredServers.length})</span>}</h3>
          </div>
          <button className="icon-button ghost compact" onClick={onManageInventory}>
            <Settings size={15} />
            Manage Inventory
          </button>
        </div>
        <div className="search-results-toolbar">
          <div className="search-results-summary">
            <span>Search Results</span>
            <strong>{resultStart}-{resultEnd}</strong>
            <span>of {filteredServers.length} IDs</span>
          </div>
          <div className="search-results-controls">
            <label>
              IDs per page
              <select
                aria-label="IDs per page"
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value))}
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
              </select>
            </label>
            <button
              className="inventory-page-button"
              aria-label="Previous results page"
              title="Previous results page"
              disabled={currentPageIndex === 0}
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="search-results-page">
              Page {filteredServers.length === 0 ? 0 : currentPageIndex + 1} / {filteredServers.length === 0 ? 0 : pageCount}
            </span>
            <button
              className="inventory-page-button"
              aria-label="Next results page"
              title="Next results page"
              disabled={currentPageIndex >= pageCount - 1 || filteredServers.length === 0}
              onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <ServerTable
          servers={pagedServers}
          idSortDirection={idSortDirection}
          sshUsername={overview.sshUsername ?? null}
          onToggleIdSort={toggleIdSort}
          onOpenServer={onOpenServer}
          onUpdateServerNote={onUpdateServerNote}
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
          <h2>Server Details</h2>
          <p>{detail.server.host}:{detail.server.port}</p>
        </div>
        <div className="detail-badges">
          <ConnBadge status={latest?.connectionStatus ?? "unknown"} />
          {latest?.connectionStatus === "online" && latest?.healthLevel ? (
            <HealthBadge level={latest.healthLevel} />
          ) : null}
          {detail.pipeline ? <TaskBadge status={detail.pipeline.displayStatus} /> : null}
        </div>
      </section>

      <TaskPanel task={detail.pipeline} />

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
  sshUsername,
  onToggleIdSort,
  onOpenServer,
  onUpdateServerNote
}: {
  servers: ServerRow[];
  idSortDirection: SortDirection;
  sshUsername: string | null;
  onToggleIdSort: () => void;
  onOpenServer: (serverId: string) => void;
  onUpdateServerNote: (serverId: string, note: string) => Promise<void>;
}) {
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [copiedSshServerId, setCopiedSshServerId] = useState<string | null>(null);

  const startEditingNote = (server: ServerRow) => {
    setEditingNoteId(server.id);
    setDraftNote(server.note);
  };

  const cancelEditingNote = () => {
    setEditingNoteId(null);
    setDraftNote("");
  };

  const commitNote = async (server: ServerRow) => {
    const nextNote = draftNote.trim();
    if (nextNote === "" || nextNote === server.note) {
      cancelEditingNote();
      return;
    }

    setSavingId(server.id);
    try {
      await onUpdateServerNote(server.id, nextNote);
      cancelEditingNote();
    } finally {
      setSavingId(null);
    }
  };

  const copySshCommand = async (server: ServerRow) => {
    if (!sshUsername) return;

    try {
      await writeTextToClipboard(formatSshCommand(server, sshUsername));
      setCopiedSshServerId(server.id);
      window.setTimeout(() => {
        setCopiedSshServerId((current) => current === server.id ? null : current);
      }, 1500);
    } catch (error) {
      console.error("Failed to copy SSH command", error);
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
            <th>Task</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Disk</th>
            <th>Load</th>
            <th>Uptime</th>
            <th>Note</th>
            <th aria-label="SSH">SSH</th>
          </tr>
        </thead>
        <tbody>
          {servers.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={13}>No servers configured.</td>
            </tr>
          ) : null}
          {servers.map((server) => (
            <tr key={server.id} onClick={() => onOpenServer(server.id)}>
              <td>
                <span className="server-id-value">{server.id}</span>
              </td>
              <td>
                <span
                  className={
                    resolveServerDatasetName(server)
                      ? "server-dataset-name inventory-display-name has-dataset"
                      : "server-dataset-name inventory-display-name"
                  }
                >
                  {formatServerDatasetName(server)}
                </span>
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
              <td>
                {server.pipeline ? (
                  <TaskBadge status={server.pipeline.displayStatus} />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td>{formatPercent(server.latest?.cpuUsedPercent)}</td>
              <td>{formatPercent(server.latest?.memoryUsedPercent)}</td>
              <td>{formatPercent(server.latest?.diskUsedPercent)}</td>
              <td>{server.latest?.load1?.toFixed(2) ?? "-"}</td>
              <td>{formatDuration(server.latest?.uptimeSeconds)}</td>
              <td>
                {editingNoteId === server.id ? (
                  <input
                    className="server-name-input"
                    aria-label={`Server note for ${server.id}`}
                    value={draftNote}
                    disabled={savingId === server.id}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setDraftNote(event.target.value)}
                    onBlur={() => void commitNote(server)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        cancelEditingNote();
                      }
                    }}
                  />
                ) : (
                  <button
                    className="row-button"
                    aria-label={`Edit note for ${server.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      startEditingNote(server);
                    }}
                  >
                    {server.note}
                  </button>
                )}
              </td>
              <td className="ssh-copy-cell">
                <button
                  className={
                    copiedSshServerId === server.id
                      ? "inventory-action-button ssh-copy-button copied"
                      : "inventory-action-button ssh-copy-button"
                  }
                  aria-label={`Copy SSH command for ${server.id}`}
                  title={sshUsername ? formatSshCommand(server, sshUsername) : "SSH username is not configured"}
                  disabled={!sshUsername}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copySshCommand(server);
                  }}
                >
                  {copiedSshServerId === server.id ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryManageView({
  servers,
  onBack,
  onCreateServer,
  onUpdateServer,
  onRemoveServer
}: {
  servers: ServerRow[];
  onBack: () => void;
  onCreateServer: (input: ServerInventoryCreateInput) => Promise<void>;
  onUpdateServer: (serverId: string, patch: ServerInventoryUpdatePatch) => Promise<void>;
  onRemoveServer: (serverId: string) => Promise<void>;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newDraft, setNewDraft] = useState<ServerInventoryDraft>(emptyServerDraft);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ServerInventoryDraft>(emptyServerDraft);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" })),
    [servers]
  );
  const enabledCount = servers.filter((server) => server.enabled).length;

  const startEditingServer = (server: ServerRow) => {
    setInventoryError(null);
    setConfirmDeleteId(null);
    setEditingServerId(server.id);
    setEditDraft(draftFromServer(server));
  };

  const cancelEditingServer = () => {
    setEditingServerId(null);
    setEditDraft(emptyServerDraft());
  };

  const submitNewServer = async (event: FormEvent) => {
    event.preventDefault();
    setInventoryError(null);
    setSavingId("new-server");
    try {
      await onCreateServer(serverDraftToPayload(newDraft));
      setNewDraft(emptyServerDraft());
      setShowAddForm(false);
    } catch (caught) {
      setInventoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingId(null);
    }
  };

  const submitServerUpdate = async (server: ServerRow) => {
    setInventoryError(null);
    setSavingId(server.id);
    try {
      await onUpdateServer(server.id, serverDraftToPatch(editDraft));
      cancelEditingServer();
    } catch (caught) {
      setInventoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingId(null);
    }
  };

  const removeInventoryServer = async (server: ServerRow) => {
    setInventoryError(null);
    setSavingId(server.id);
    try {
      await onRemoveServer(server.id);
      setConfirmDeleteId(null);
      if (editingServerId === server.id) {
        cancelEditingServer();
      }
    } catch (caught) {
      setInventoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <>
      <button className="icon-button ghost" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to Overview
      </button>

      <section className="section-heading inventory-manage-heading">
        <div>
          <h2>Inventory Management</h2>
          <p>{servers.length} servers configured · {enabledCount} enabled</p>
        </div>
        <button
          className="icon-button primary"
          onClick={() => {
            setInventoryError(null);
            setShowAddForm((current) => !current);
          }}
          aria-label={showAddForm ? "Cancel adding server" : "Add server"}
        >
          {showAddForm ? <X size={16} /> : <Plus size={16} />}
          {showAddForm ? "Cancel" : "Add Server"}
        </button>
      </section>

      <section className="panel inventory-manage-panel">
        <div className="inventory-toolbar">
          <div className="inventory-toolbar-meta">
            <strong>Server List</strong>
            <span className="inventory-generated-pill">ID and name are automatic</span>
          </div>
        </div>

        {showAddForm ? (
          <form className="server-inventory-form" onSubmit={submitNewServer}>
            <InventoryDraftFields
              draft={newDraft}
              disabled={savingId === "new-server"}
              onChange={(patch) => setNewDraft((current) => ({ ...current, ...patch }))}
            />
            <div className="server-form-actions">
              <button className="icon-button primary compact" type="submit" disabled={savingId === "new-server"}>
                <Save size={15} />
                Save
              </button>
              <button
                className="icon-button ghost compact"
                type="button"
                disabled={savingId === "new-server"}
                onClick={() => {
                  setShowAddForm(false);
                  setNewDraft(emptyServerDraft());
                }}
              >
                <X size={15} />
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {inventoryError ? <div className="notice error compact-notice">{inventoryError}</div> : null}

        <div className="table-wrap inventory-manage-table">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Host</th>
                <th>Port</th>
                <th>Group</th>
                <th>Enabled</th>
                <th>Note</th>
                <th>Solver</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedServers.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={9}>No servers configured.</td>
                </tr>
              ) : null}
              {sortedServers.map((server) => {
                const isEditingServer = editingServerId === server.id;
                return (
                  <tr key={server.id} className={isEditingServer ? "inventory-edit-row" : undefined}>
                    <td>
                      <span className="server-id-value">{server.id}</span>
                    </td>
                    <td>
                      <span className="server-dataset-name">{server.name}</span>
                    </td>
                    <td>
                      {isEditingServer ? (
                        <input
                          className="server-name-input inventory-cell-input"
                          aria-label={`Host for ${server.id}`}
                          value={editDraft.host}
                          disabled={savingId === server.id}
                          onChange={(event) => setEditDraft((current) => ({ ...current, host: event.target.value }))}
                        />
                      ) : (
                        <span className="server-host-value">{server.host}</span>
                      )}
                    </td>
                    <td>
                      {isEditingServer ? (
                        <input
                          className="server-name-input inventory-port-input"
                          aria-label={`Port for ${server.id}`}
                          type="number"
                          min="1"
                          max="65535"
                          value={editDraft.port}
                          disabled={savingId === server.id}
                          onChange={(event) => setEditDraft((current) => ({ ...current, port: event.target.value }))}
                        />
                      ) : (
                        <span className="port-value">{server.port}</span>
                      )}
                    </td>
                    <td>
                      {isEditingServer ? (
                        <input
                          className="server-name-input inventory-group-input"
                          aria-label={`Group for ${server.id}`}
                          value={editDraft.group}
                          disabled={savingId === server.id}
                          onChange={(event) => setEditDraft((current) => ({ ...current, group: event.target.value }))}
                        />
                      ) : (
                        <span className="server-group-value">{server.group ?? "—"}</span>
                      )}
                    </td>
                    <td>
                      {isEditingServer ? (
                        <label className="inventory-switch">
                          <input
                            type="checkbox"
                            aria-label={`Enabled for ${server.id}`}
                            checked={editDraft.enabled}
                            disabled={savingId === server.id}
                            onChange={(event) => setEditDraft((current) => ({ ...current, enabled: event.target.checked }))}
                          />
                          <span>{editDraft.enabled ? "enabled" : "disabled"}</span>
                        </label>
                      ) : (
                        <span className={`inventory-enabled-badge ${server.enabled ? "enabled" : "disabled"}`}>
                          {server.enabled ? "enabled" : "disabled"}
                        </span>
                      )}
                    </td>
                    <td>
                      {isEditingServer ? (
                        <input
                          className="server-name-input inventory-note-input"
                          aria-label={`Inventory note for ${server.id}`}
                          value={editDraft.note}
                          disabled={savingId === server.id}
                          onChange={(event) => setEditDraft((current) => ({ ...current, note: event.target.value }))}
                        />
                      ) : (
                        <span>{server.note}</span>
                      )}
                    </td>
                    <td>
                      {isEditingServer ? (
                        <div className="inventory-solver-fields">
                          <input
                            className="server-name-input inventory-solver-input"
                            aria-label={`Solver root for ${server.id}`}
                            placeholder="/home/user/solver"
                            value={editDraft.solverRoot}
                            disabled={savingId === server.id}
                            onChange={(event) => setEditDraft((current) => ({ ...current, solverRoot: event.target.value }))}
                          />
                          <input
                            className="server-name-input inventory-solver-input"
                            aria-label={`Tmux session for ${server.id}`}
                            placeholder="solver"
                            value={editDraft.tmuxSession}
                            disabled={savingId === server.id}
                            onChange={(event) => setEditDraft((current) => ({ ...current, tmuxSession: event.target.value }))}
                          />
                          <input
                            className="server-name-input inventory-solver-input"
                            aria-label={`Pipeline status file for ${server.id}`}
                            placeholder="~/run/solver_running_status.json"
                            value={editDraft.pipelineStatusFilePath}
                            disabled={savingId === server.id}
                            onChange={(event) => setEditDraft((current) => ({ ...current, pipelineStatusFilePath: event.target.value }))}
                          />
                        </div>
                      ) : (
                        <span className={`inventory-solver-badge ${server.solverRoot ? "configured" : "missing"}`}>
                          {server.solverRoot ? "configured" : "missing"}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="inventory-row-actions">
                        {isEditingServer ? (
                          <>
                            <button
                              className="inventory-action-button primary"
                              aria-label={`Save server ${server.id}`}
                              title={`Save server ${server.id}`}
                              disabled={savingId === server.id}
                              onClick={() => void submitServerUpdate(server)}
                            >
                              <Check size={15} />
                            </button>
                            <button
                              className="inventory-action-button"
                              aria-label={`Cancel editing ${server.id}`}
                              title={`Cancel editing ${server.id}`}
                              disabled={savingId === server.id}
                              onClick={cancelEditingServer}
                            >
                              <X size={15} />
                            </button>
                          </>
                        ) : confirmDeleteId === server.id ? (
                          <>
                            <button
                              className="inventory-confirm-button danger"
                              disabled={savingId === server.id}
                              onClick={() => void removeInventoryServer(server)}
                            >
                              Delete
                            </button>
                            <button
                              className="inventory-confirm-button"
                              disabled={savingId === server.id}
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="inventory-action-button"
                              aria-label={`Edit server ${server.id}`}
                              title={`Edit server ${server.id}`}
                              onClick={() => startEditingServer(server)}
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              className="inventory-action-button danger"
                              aria-label={`Delete server ${server.id}`}
                              title={`Delete server ${server.id}`}
                              onClick={() => setConfirmDeleteId(server.id)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function InventoryDraftFields({
  draft,
  disabled,
  onChange
}: {
  draft: ServerInventoryDraft;
  disabled: boolean;
  onChange: (patch: Partial<ServerInventoryDraft>) => void;
}) {
  return (
    <>
      <label className="inventory-field">
        <span>Host</span>
        <input
          required
          value={draft.host}
          disabled={disabled}
          onChange={(event) => onChange({ host: event.target.value })}
        />
      </label>
      <label className="inventory-field small">
        <span>Port</span>
        <input
          required
          type="number"
          min="1"
          max="65535"
          value={draft.port}
          disabled={disabled}
          onChange={(event) => onChange({ port: event.target.value })}
        />
      </label>
      <label className="inventory-field">
        <span>Group</span>
        <input
          value={draft.group}
          disabled={disabled}
          onChange={(event) => onChange({ group: event.target.value })}
        />
      </label>
      <label className="inventory-field wide">
        <span>Note</span>
        <input
          value={draft.note}
          disabled={disabled}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </label>
      <label className="inventory-field wide">
        <span>Solver Root</span>
        <input
          value={draft.solverRoot}
          disabled={disabled}
          placeholder="/home/user/solver"
          onChange={(event) => onChange({ solverRoot: event.target.value })}
        />
      </label>
      <label className="inventory-field">
        <span>Tmux Session</span>
        <input
          value={draft.tmuxSession}
          disabled={disabled}
          placeholder="solver"
          onChange={(event) => onChange({ tmuxSession: event.target.value })}
        />
      </label>
      <label className="inventory-field wide">
        <span>Status File</span>
        <input
          value={draft.pipelineStatusFilePath}
          disabled={disabled}
          placeholder="~/run/solver_running_status.json"
          onChange={(event) => onChange({ pipelineStatusFilePath: event.target.value })}
        />
      </label>
      <label className="inventory-switch form-switch">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        <span>{draft.enabled ? "enabled" : "disabled"}</span>
      </label>
    </>
  );
}

function emptyServerDraft(): ServerInventoryDraft {
  return {
    host: "",
    port: "22",
    group: "",
    enabled: true,
    note: "TBD",
    solverRoot: "",
    tmuxSession: "",
    pipelineStatusFilePath: ""
  };
}

function draftFromServer(server: ServerRow): ServerInventoryDraft {
  return {
    host: server.host,
    port: String(server.port),
    group: server.group ?? "",
    enabled: server.enabled,
    note: server.note,
    solverRoot: server.solverRoot ?? "",
    tmuxSession: server.tmuxSession ?? "",
    pipelineStatusFilePath: server.pipelineStatusFilePath ?? ""
  };
}

function serverDraftToPayload(draft: ServerInventoryDraft): ServerInventoryCreateInput {
  const host = draft.host.trim();
  if (!host) {
    throw new Error("Host is required");
  }

  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer from 1 to 65535");
  }

  const group = draft.group.trim();
  const note = draft.note.trim();
  const solverRoot = draft.solverRoot.trim();
  const tmuxSession = draft.tmuxSession.trim();
  const pipelineStatusFilePath = draft.pipelineStatusFilePath.trim();
  return {
    host,
    port,
    group: group || null,
    enabled: draft.enabled,
    note: note || "TBD",
    solverRoot: solverRoot || null,
    tmuxSession: tmuxSession || null,
    pipelineStatusFilePath: pipelineStatusFilePath || null
  };
}

function serverDraftToPatch(draft: ServerInventoryDraft): ServerInventoryUpdatePatch {
  return serverDraftToPayload(draft);
}

/** Connection status badge — shows online / offline / unknown. */
function ConnBadge({ status }: { status: ConnectionStatus }) {
  return <span className={`badge conn-badge ${status}`}>{status}</span>;
}

/** Health level badge — shows healthy / warning / dangerous. */
function HealthBadge({ level }: { level: HealthLevel }) {
  return <span className={`badge health-badge ${level}`}>{level}</span>;
}

function TaskBadge({ status }: { status: PipelineDisplayStatus }) {
  return <span className={`badge task-badge ${status}`}>{formatTaskStatusLabel(status)}</span>;
}

function TaskPanel({ task }: { task: PipelineStatusSnapshot | null }) {
  if (!task) {
    return (
      <section className="panel task-panel">
        <div className="panel-title">
          <Workflow size={16} />
          <h3>Solver Task</h3>
        </div>
        <p className="task-empty">No task status collected yet.</p>
      </section>
    );
  }

  const progress = taskProgressPercent(task);

  return (
    <section className="panel task-panel">
      <div className="panel-title">
        <Workflow size={16} />
        <h3>Solver Task</h3>
      </div>

      <div className="task-summary-grid">
        <div>
          <span className="settings-status-label">Status</span>
          <TaskBadge status={task.displayStatus} />
        </div>
        <div>
          <span className="settings-status-label">Process</span>
          <strong>{formatProcessAlive(task.processAlive)}</strong>
        </div>
        <div>
          <span className="settings-status-label">Scenario</span>
          <strong>{task.scenario ?? "—"}</strong>
        </div>
        <div>
          <span className="settings-status-label">Dataset</span>
          <strong>{task.datasetName ?? task.repoId ?? "—"}</strong>
        </div>
        <div>
          <span className="settings-status-label">Batch</span>
          <strong>{formatTaskBatch(task)}</strong>
        </div>
        <div>
          <span className="settings-status-label">Updated</span>
          <strong>{formatDate(task.updatedAt)}</strong>
        </div>
      </div>

      {progress != null ? (
        <div className="task-progress">
          <div className="task-progress-label">
            <span>Batch progress</span>
            <strong>{progress}%</strong>
          </div>
          <div className="task-progress-track">
            <div className="task-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : null}

      {task.command ? (
        <div className="task-command">
          <span className="settings-status-label">Command</span>
          <code>{task.command}</code>
        </div>
      ) : null}

      {task.error ? <div className="notice error">{task.error}</div> : null}
      {task.errorMessage ? <div className="notice error">{task.errorMessage}</div> : null}
    </section>
  );
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

function formatSshCommand(server: ServerRow, username: string): string {
  return `ssh -p ${server.port} ${username}@${server.host}`;
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/servers\/([^/]+)$/);
  if (match) return { name: "detail", id: decodeURIComponent(match[1]) };
  if (window.location.pathname === "/inventory") return { name: "inventory" };
  if (window.location.pathname === "/preflop-ranges") return { name: "preflop" };
  return { name: "overview" };
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

function isTaskActive(task: PipelineStatusSnapshot | null | undefined): boolean {
  if (!task) return false;
  return (
    task.displayStatus === "running" ||
    task.displayStatus === "solving" ||
    task.displayStatus === "uploading" ||
    task.displayStatus === "cleanup"
  );
}

function resolveServerDatasetName(server: ServerRow): string | null {
  return server.pipeline?.datasetName ?? server.lastDatasetName;
}

function formatServerDatasetName(server: ServerRow): string {
  return resolveServerDatasetName(server) ?? server.name;
}

function formatTaskStatusLabel(status: PipelineDisplayStatus): string {
  return status.replace(/_/g, " ");
}

function formatTaskBatch(task: PipelineStatusSnapshot): string {
  if (task.currentBatch != null && task.totalBatches != null) {
    const expr = task.batchExpr ? ` (${task.batchExpr})` : "";
    return `${task.currentBatch}/${task.totalBatches}${expr}`;
  }
  if (task.totalTasks != null) return `${task.totalTasks} tasks`;
  return "—";
}

function formatProcessAlive(processAlive: boolean | null): string {
  if (processAlive === true) return "Alive";
  if (processAlive === false) return "Not running";
  return "—";
}

function taskProgressPercent(task: PipelineStatusSnapshot): number | null {
  if (task.currentBatch == null || task.totalBatches == null || task.totalBatches <= 0) {
    return null;
  }
  return Math.min(100, Math.round((task.currentBatch / task.totalBatches) * 100));
}
