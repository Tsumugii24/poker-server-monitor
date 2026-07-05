import {
  AlertTriangle,
  Check,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Timer,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AlertSettings,
  AlertStatus,
  HfProxyRuntimeStatus,
  WeChatAccountConnectorStatus,
  WeChatAccountsStatus
} from "../shared/types";
import {
  buildWeChatChecklist,
  getWeChatDeliveryCopy
} from "../shared/wechatDelivery";
import { WeChatQrPanel } from "./WeChatQrPanel";

type SettingsTab = "recipients" | "connection" | "check" | "status";

type SettingsWizardProps = {
  settings: AlertSettings;
  status: AlertStatus | null;
  hfProxyStatus: HfProxyRuntimeStatus | null;
  saving: boolean;
  wechatAccountsStatus: WeChatAccountsStatus;
  onClose: () => void;
  onSave: (settings: AlertSettings) => Promise<void>;
  onTest: (settings: AlertSettings) => Promise<void>;
  onCreateWeChatAccount: () => Promise<WeChatAccountConnectorStatus | null>;
  onRefreshWeChatAccounts: () => Promise<void>;
  onRefreshWeChatAccountQr: (accountId: string) => Promise<void>;
  onRestoreWeChatAccount: (accountId: string) => Promise<void>;
  onLogoutWeChatAccount: (accountId: string) => Promise<void>;
  onUpdateWeChatAccount: (accountId: string, patch: { label?: string; enabled?: boolean }) => Promise<void>;
  onRemoveWeChatAccount: (accountId: string) => Promise<void>;
  onVerifyWeChatAccount: (accountId: string, targetUserId?: string) => Promise<void>;
  onTestWeChatAccount: (accountId: string) => Promise<void>;
};

export function SettingsWizard({
  settings,
  status,
  hfProxyStatus,
  saving,
  wechatAccountsStatus,
  onClose,
  onSave,
  onTest,
  onCreateWeChatAccount,
  onRefreshWeChatAccounts,
  onRefreshWeChatAccountQr,
  onRestoreWeChatAccount,
  onLogoutWeChatAccount,
  onUpdateWeChatAccount,
  onRemoveWeChatAccount,
  onVerifyWeChatAccount,
  onTestWeChatAccount
}: SettingsWizardProps) {
  const [draft, setDraft] = useState<AlertSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>("recipients");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    wechatAccountsStatus.activeLoginAccountId ?? wechatAccountsStatus.accounts[0]?.id ?? null
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const language = draft.language ?? "en";
  const copy = COPY[language];
  const accounts = wechatAccountsStatus.accounts;
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? accounts[0] ?? null,
    [accounts, selectedAccountId]
  );
  const selectedConnector = selectedAccount?.connector ?? null;
  const selectedDeliveryCopy = selectedConnector
    ? getWeChatDeliveryCopy(selectedConnector.delivery, language, selectedConnector.target)
    : null;
  const selectedChecklist = selectedConnector ? buildWeChatChecklist(selectedConnector, language) : [];
  const selectedNeedsVerification = Boolean(selectedAccount && selectedConnector?.loggedIn && !selectedAccount.verified);
  const latestVerificationChat = selectedConnector?.recentChats[0] ?? null;
  const selectedContextRefreshTarget = selectedAccount ? getContextRefreshTarget(selectedAccount) : null;

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (wechatAccountsStatus.activeLoginAccountId) {
      setSelectedAccountId(wechatAccountsStatus.activeLoginAccountId);
      return;
    }
    if (selectedAccountId && accounts.some((account) => account.id === selectedAccountId)) {
      return;
    }
    setSelectedAccountId(accounts[0]?.id ?? null);
  }, [accounts, selectedAccountId, wechatAccountsStatus.activeLoginAccountId]);

  useEffect(() => {
    if (!wechatAccountsStatus.activeLoginAccountId) return;
    const pendingVerificationAccount = accounts.find((account) =>
      account.id === wechatAccountsStatus.activeLoginAccountId &&
      account.connector.loggedIn &&
      !account.verified
    );
    if (!pendingVerificationAccount) return;
    setSelectedAccountId(pendingVerificationAccount.id);
    setActiveTab("connection");
  }, [accounts, wechatAccountsStatus.activeLoginAccountId]);

  const tabs: Array<{ id: SettingsTab; label: string; badge?: string }> = [
    {
      id: "recipients",
      label: copy.tabs.recipients,
      badge: wechatAccountsStatus.enabledCount > 0 ? String(wechatAccountsStatus.enabledCount) : undefined
    },
    {
      id: "connection",
      label: copy.tabs.connection,
      badge: selectedAccount?.connector.loggedIn ? "●" : undefined
    },
    { id: "check", label: copy.tabs.check },
    { id: "status", label: copy.tabs.status }
  ];

  const handleSave = async () => {
    setActionError(null);
    try {
      await onSave({
        ...draft,
        cooldownMinutes: Math.max(1, draft.cooldownMinutes),
        sshCommandTimeoutSeconds: Math.max(1, draft.sshCommandTimeoutSeconds),
        sshConnectTimeoutSeconds: Math.max(1, draft.sshConnectTimeoutSeconds)
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCreateAccount = async () => {
    setBusyAccountId("__new__");
    setActionError(null);
    try {
      const account = await onCreateWeChatAccount();
      if (account) {
        setSelectedAccountId(account.id);
      }
      setActiveTab("connection");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAccountId(null);
    }
  };

  const runAccountAction = async (
    accountId: string,
    action: () => Promise<void>,
    nextTab?: SettingsTab
  ) => {
    setBusyAccountId(accountId);
    setActionError(null);
    try {
      await action();
      if (nextTab) setActiveTab(nextTab);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAccountId(null);
    }
  };

  const startEditAccount = (account: WeChatAccountConnectorStatus) => {
    setConfirmDeleteId(null);
    setEditingAccountId(account.id);
    setEditLabel(account.label);
  };

  const saveAccountLabel = async (account: WeChatAccountConnectorStatus) => {
    if (!editLabel.trim()) return;
    await runAccountAction(account.id, async () => {
      await onUpdateWeChatAccount(account.id, { label: editLabel.trim() });
      setEditingAccountId(null);
      setEditLabel("");
    });
  };

  const handleTestAccount = async (accountId: string) => {
    setTestingAccountId(accountId);
    setActionError(null);
    try {
      await onTestWeChatAccount(accountId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setTestingAccountId(null);
    }
  };

  const renderAccountControls = (account: WeChatAccountConnectorStatus) => (
    <div className="sw-recipient-controls">
      <label className="sw-toggle" title={account.enabled ? copy.accounts.enabled : copy.accounts.disabled}>
        <input
          type="checkbox"
          checked={account.enabled}
          onChange={(event) => void runAccountAction(account.id, () =>
            onUpdateWeChatAccount(account.id, { enabled: event.target.checked })
          )}
          disabled={saving || busyAccountId === account.id}
        />
        <span className="sw-toggle-track">
          <span className="sw-toggle-thumb" />
        </span>
      </label>
      <button
        className="sw-btn-icon"
        disabled={saving || busyAccountId === account.id}
        onClick={() => {
          setSelectedAccountId(account.id);
          setActiveTab("connection");
        }}
        title={copy.accounts.connection}
        aria-label={`${copy.accounts.connection}: ${account.label}`}
      >
        <LogIn size={13} />
      </button>
      <button
        className="sw-btn-icon"
        disabled={saving || busyAccountId === account.id}
        onClick={() => startEditAccount(account)}
        title={copy.accounts.edit}
        aria-label={`${copy.accounts.edit}: ${account.label}`}
      >
        <Pencil size={13} />
      </button>
      <button
        className="sw-btn-icon"
        disabled={saving || testingAccountId === account.id || !account.enabled || !account.verified}
        onClick={() => void handleTestAccount(account.id)}
        title={copy.accounts.test}
        aria-label={`${copy.accounts.test}: ${account.label}`}
      >
        <Send size={13} />
      </button>
      {confirmDeleteId === account.id ? (
        <div className="sw-delete-confirm">
          <button
            className="sw-btn danger compact"
            disabled={saving || busyAccountId === account.id}
            onClick={() => void runAccountAction(account.id, () => onRemoveWeChatAccount(account.id))}
          >
            {copy.common.confirm}
          </button>
          <button className="sw-btn ghost compact" onClick={() => setConfirmDeleteId(null)}>
            {copy.common.cancel}
          </button>
        </div>
      ) : (
        <button
          className="sw-btn-icon danger"
          disabled={saving || busyAccountId === account.id}
          onClick={() => setConfirmDeleteId(account.id)}
          title={copy.accounts.remove}
          aria-label={`${copy.accounts.remove}: ${account.label}`}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );

  return (
    <section className="panel settings-panel settings-wizard" aria-label="Settings" role="dialog" aria-modal="true">
      <div className="sw-header">
        <div className="sw-header-left">
          <Settings size={16} />
          <h3>{copy.title}</h3>
        </div>
        <button className="sw-close-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <nav className="sw-tabs" aria-label={copy.tabsLabel}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`sw-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => { setActiveTab(tab.id); setActionError(null); }}
          >
            <span className="sw-tab-text">{tab.label}</span>
            {tab.badge ? (
              <span className={`sw-tab-badge${tab.badge === "●" ? " dot" : ""}`}>
                {tab.badge === "●" ? "" : tab.badge}
              </span>
            ) : null}
          </button>
        ))}
        <span className="sw-tab-indicator" />
      </nav>

      {actionError ? <div className="notice error sw-notice">{actionError}</div> : null}

      <div className="sw-body">
        {activeTab === "recipients" ? (
          <div className="sw-tab-panel">
            <div className="sw-recipients-header">
              <div>
                <h4>{copy.accounts.title}</h4>
                <p className="sw-help">{copy.accounts.detail}</p>
              </div>
              <button
                className="sw-btn primary compact"
                onClick={() => void handleCreateAccount()}
                disabled={saving || busyAccountId === "__new__"}
              >
                <Plus size={14} />
                {copy.accounts.add}
              </button>
            </div>

            {accounts.length > 0 ? (
              <div className="sw-recipient-list">
                {accounts.map((account) => {
                  const contextRefreshTarget = getContextRefreshTarget(account);
                  return (
                    <div
                      key={account.id}
                      className={`sw-recipient-card${account.enabled ? " enabled" : " disabled"}${account.verified ? " verified" : ""}${contextRefreshTarget ? " context-stale" : ""}`}
                    >
                      {editingAccountId === account.id ? (
                        <div className="sw-recipient-edit">
                          <div className="sw-recipient-edit-fields one">
                            <div className="sw-field">
                              <label>{copy.accounts.labelField}</label>
                              <input value={editLabel} onChange={(event) => setEditLabel(event.target.value)} autoFocus />
                            </div>
                          </div>
                          <div className="sw-recipient-edit-actions">
                            <button
                              className="sw-btn primary compact"
                              disabled={saving || busyAccountId === account.id || !editLabel.trim()}
                              onClick={() => void saveAccountLabel(account)}
                            >
                              <Check size={14} />
                              {copy.accounts.saveAccount}
                            </button>
                            <button
                              className="sw-btn ghost compact"
                              disabled={busyAccountId === account.id}
                              onClick={() => {
                                setEditingAccountId(null);
                                setEditLabel("");
                              }}
                            >
                              {copy.common.cancel}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="sw-recipient-main">
                          <div className="sw-recipient-info">
                            <strong className="sw-recipient-label">{account.label}</strong>
                            <span className="sw-recipient-contact">
                              {account.botUserId ?? account.connector.botUserId ?? copy.accounts.pendingBotId}
                            </span>
                            <span className="sw-recipient-date">
                              {accountStatusLabel(account, copy)} · {copy.accounts.added} {formatDate(account.addedAt)}
                            </span>
                            {account.alertTargetUserId ? (
                              <span className="sw-recipient-contact muted">{copy.accounts.target}: {account.alertTargetUserId}</span>
                            ) : null}
                          </div>
                          {renderAccountControls(account)}
                        </div>
                      )}
                      {testingAccountId === account.id ? (
                        <div className="sw-recipient-testing">{copy.accounts.testing}</div>
                      ) : null}
                      {!account.verified && account.connector.loggedIn ? (
                        <div className="sw-recipient-testing warning">{copy.accounts.needsVerification}</div>
                      ) : null}
                      {contextRefreshTarget ? (
                        <div className="sw-recipient-testing error">
                          {copy.accounts.contextRefreshRequired}: <code>{contextRefreshTarget}</code>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="sw-empty-state">
                <p>{copy.accounts.empty}</p>
                <button className="sw-btn primary" onClick={() => void handleCreateAccount()}>
                  <Plus size={14} />
                  {copy.accounts.addFirst}
                </button>
              </div>
            )}

            <div className="sw-global-settings">
              <h4>{copy.accounts.globalSettings}</h4>
              <div className="sw-settings-grid">
                <div className="sw-field sw-toggle-field">
                  <div>
                    <label>{copy.accounts.globalAlertDelivery}</label>
                    <span className="sw-field-hint">{copy.accounts.globalAlertDeliveryHelp}</span>
                  </div>
                  <label className="sw-toggle">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        enabled: event.target.checked
                      }))}
                      disabled={saving}
                    />
                    <span className="sw-toggle-track">
                      <span className="sw-toggle-thumb" />
                    </span>
                  </label>
                  <strong className="sw-toggle-value">
                    {draft.enabled ? copy.accounts.globalAlertEnabled : copy.accounts.globalAlertDisabled}
                  </strong>
                </div>
                <div className="sw-field">
                  <label>{copy.accounts.language}</label>
                  <select
                    value={draft.language ?? "en"}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      language: event.target.value === "zh" ? "zh" : "en"
                    }))}
                  >
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                  </select>
                </div>
                <div className="sw-field">
                  <label>{copy.accounts.cooldown}</label>
                  <input
                    type="number"
                    min="1"
                    value={draft.cooldownMinutes || ""}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      cooldownMinutes: event.target.value === "" ? 0 : Math.max(1, Number(event.target.value) || 1)
                    }))}
                  />
                  <span className="sw-field-hint">{copy.accounts.cooldownHelp}</span>
                </div>
              </div>
              <div className="sw-actions">
                <button className="sw-btn primary" disabled={saving} onClick={() => void handleSave()}>
                  {copy.accounts.saveSettings}
                </button>
                <button className="sw-btn ghost" disabled={saving} onClick={() => void onTest(draft)}>
                  <Send size={14} />
                  {copy.accounts.testAll}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "connection" ? (
          <div className="sw-tab-panel">
            <div className="sw-recipients-header">
              <div>
                <h4>{copy.connection.title}</h4>
                <p className="sw-help">{copy.connection.detail}</p>
              </div>
              <button className="sw-btn ghost compact" disabled={saving} onClick={() => void onRefreshWeChatAccounts()}>
                <RefreshCw size={14} />
                {copy.refreshStatus}
              </button>
            </div>

            {selectedAccount ? (
              <>
                <div className="sw-account-card">
                  <div className="sw-account-main">
                    <div className="sw-account-avatar">
                      <UserRound size={18} />
                    </div>
                    <div className="sw-account-info">
                      <span className="sw-account-label">{copy.connection.selected}</span>
                      <strong>{selectedAccount.label}</strong>
                    </div>
                  </div>
                  <div className="sw-account-actions">
                    <button
                      className="sw-btn-icon"
                      disabled={saving || busyAccountId === selectedAccount.id}
                      onClick={() => void runAccountAction(
                        selectedAccount.id,
                        () => onRefreshWeChatAccountQr(selectedAccount.id)
                      )}
                      title={copy.connection.refreshQr}
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      className="sw-btn-icon danger"
                      disabled={saving || busyAccountId === selectedAccount.id}
                      onClick={() => void runAccountAction(
                        selectedAccount.id,
                        () => onLogoutWeChatAccount(selectedAccount.id)
                      )}
                      title={copy.connection.logout}
                    >
                      <LogOut size={14} />
                    </button>
                  </div>
                </div>

                {selectedConnector?.lastError && !selectedConnector.loggedIn ? (
                  <div className="notice error">{selectedConnector.lastError}</div>
                ) : null}

                {selectedConnector?.qrUrl ? (
                  <WeChatQrPanel
                    url={selectedConnector.qrUrl}
                    language={language}
                    refreshing={saving || busyAccountId === selectedAccount.id}
                    onRefresh={() => void runAccountAction(
                      selectedAccount.id,
                      () => onRefreshWeChatAccountQr(selectedAccount.id)
                    )}
                  />
                ) : selectedConnector?.awaitingQr ? (
                  <div className="sw-waiting">{copy.connection.fetchingQr}</div>
                ) : selectedConnector?.loggedIn && !selectedNeedsVerification ? (
                  <div className="sw-inline-success">{copy.connection.loggedIn}</div>
                ) : (
                  <div className="sw-actions">
                    {selectedConnector?.storedSession.available ? (
                      <button
                        className="sw-btn ghost"
                        disabled={saving || busyAccountId === selectedAccount.id}
                        onClick={() => void runAccountAction(
                          selectedAccount.id,
                          () => onRestoreWeChatAccount(selectedAccount.id)
                        )}
                      >
                        {copy.connection.restore}
                      </button>
                    ) : null}
                    <button
                      className="sw-btn primary"
                      disabled={saving || busyAccountId === selectedAccount.id}
                      onClick={() => void runAccountAction(
                        selectedAccount.id,
                        () => onRefreshWeChatAccountQr(selectedAccount.id)
                      )}
                    >
                      {copy.connection.startLogin}
                    </button>
                  </div>
                )}

                {selectedNeedsVerification ? (
                  <div className="sw-verification-panel">
                    <div className="sw-verification-header">
                      <div>
                        <h4>{copy.connection.verificationTitle}</h4>
                        <p className="sw-help">{copy.connection.contextHint}</p>
                      </div>
                      <button className="sw-btn ghost compact" disabled={saving} onClick={() => void onRefreshWeChatAccounts()}>
                        <RefreshCw size={14} />
                        {copy.connection.detectMessages}
                      </button>
                    </div>
                    <div className="sw-verification-steps">
                      <div className="sw-verification-step done">
                        <span>1</span>
                        <strong>{copy.connection.stepLogin}</strong>
                      </div>
                      <div className={`sw-verification-step${selectedConnector.recentChats.length > 0 ? " done" : " active"}`}>
                        <span>2</span>
                        <strong>{copy.connection.stepMessage}</strong>
                      </div>
                      <div className={`sw-verification-step${selectedConnector.recentChats.length > 0 ? " active" : ""}`}>
                        <span>3</span>
                        <strong>{copy.connection.stepVerify}</strong>
                      </div>
                    </div>
                    {latestVerificationChat ? (
                      <div className="sw-latest-message">
                        <span className="sw-status-label">{copy.connection.latestMessage}</span>
                        <strong>{latestVerificationChat.userId}</strong>
                        <p>{latestVerificationChat.text || copy.connection.noPreview}</p>
                        <small>{formatDate(latestVerificationChat.receivedAt)}</small>
                      </div>
                    ) : null}
                    {selectedConnector.recentChats.length > 0 ? (
                      <div className="sw-recent-chats">
                        {selectedConnector.recentChats.map((chat) => (
                          <button
                            key={chat.userId}
                            className="sw-chat-item as-button"
                            disabled={saving || busyAccountId === selectedAccount.id}
                            onClick={() => void runAccountAction(
                              selectedAccount.id,
                              () => onVerifyWeChatAccount(selectedAccount.id, chat.userId)
                            )}
                          >
                            <strong>{chat.userId}</strong>
                            <span>{chat.text || copy.connection.noPreview}</span>
                            <span className="sw-chat-time">{formatDate(chat.receivedAt)}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="sw-waiting">{copy.connection.waitingMessage}</div>
                    )}
                    <div className="sw-actions">
                      <button
                        className="sw-btn primary"
                        disabled={saving || busyAccountId === selectedAccount.id || !latestVerificationChat}
                        onClick={() => void runAccountAction(
                          selectedAccount.id,
                          () => onVerifyWeChatAccount(selectedAccount.id, latestVerificationChat?.userId)
                        )}
                      >
                        <Check size={14} />
                        {copy.connection.verify}
                      </button>
                      <button className="sw-btn ghost" disabled={saving} onClick={() => void onRefreshWeChatAccounts()}>
                        <RefreshCw size={14} />
                        {copy.refreshStatus}
                      </button>
                    </div>
                  </div>
                ) : null}

                {selectedContextRefreshTarget ? (
                  <div className="wechat-context-refresh-alert" role="alert">
                    <AlertTriangle size={18} />
                    <div>
                      <strong>{copy.connection.contextRefreshTitle}</strong>
                      <p>{copy.connection.contextRefreshAction}</p>
                      <span className="wechat-context-refresh-target">
                        {copy.connection.contextRefreshTarget}: <code>{selectedContextRefreshTarget}</code>
                      </span>
                    </div>
                  </div>
                ) : null}

                {selectedAccount.verified ? (
                  <div className="sw-inline-success">
                    {copy.connection.verified} {selectedAccount.alertTargetUserId}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="sw-empty-state">
                <p>{copy.connection.empty}</p>
                <button className="sw-btn primary" onClick={() => void handleCreateAccount()}>
                  <Plus size={14} />
                  {copy.accounts.addFirst}
                </button>
              </div>
            )}
          </div>
        ) : null}

        {activeTab === "check" ? (
          <div className="sw-tab-panel">
            <h4>{copy.check.title}</h4>
            <p className="sw-help">{copy.check.detail}</p>
            <div className="sw-global-settings">
              <div className="sw-settings-grid">
                <div className="sw-field">
                  <label>{copy.check.connectTimeout}</label>
                  <input
                    type="number"
                    min="1"
                    value={draft.sshConnectTimeoutSeconds || ""}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      sshConnectTimeoutSeconds: event.target.value === "" ? 0 : Math.max(1, Number(event.target.value) || 1)
                    }))}
                  />
                  <span className="sw-field-hint">{copy.check.connectTimeoutHelp}</span>
                </div>
                <div className="sw-field">
                  <label>{copy.check.commandTimeout}</label>
                  <input
                    type="number"
                    min="1"
                    value={draft.sshCommandTimeoutSeconds || ""}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      sshCommandTimeoutSeconds: event.target.value === "" ? 0 : Math.max(1, Number(event.target.value) || 1)
                    }))}
                  />
                  <span className="sw-field-hint">{copy.check.commandTimeoutHelp}</span>
                </div>
              </div>

              <div className="sw-proxy-settings">
                <div className="sw-proxy-header">
                  <div>
                    <h4>{copy.check.hfProxyTitle}</h4>
                    <p className="sw-help">{copy.check.hfProxyDetail}</p>
                  </div>
                </div>
                <div className="sw-proxy-grid">
                  <ProxyToggle
                    title={copy.check.serverMonitorProxy}
                    detail={copy.check.serverMonitorProxyHelp}
                    configured={hfProxyStatus?.serverMonitor.configured ?? false}
                    enabled={draft.hfProxyEnabled}
                    configuredLabel={copy.check.configured}
                    missingLabel={copy.check.notConfigured}
                    disabled={saving}
                    onChange={(checked) => setDraft((current) => ({
                      ...current,
                      hfProxyEnabled: checked
                    }))}
                  />
                  <ProxyToggle
                    title={copy.check.solverProxy}
                    detail={copy.check.solverProxyHelp}
                    configured={hfProxyStatus?.solver.configured ?? false}
                    enabled={draft.solverHfProxyEnabled}
                    configuredLabel={copy.check.configured}
                    missingLabel={copy.check.notConfigured}
                    disabled={saving}
                    onChange={(checked) => setDraft((current) => ({
                      ...current,
                      solverHfProxyEnabled: checked
                    }))}
                  />
                </div>
              </div>
              <div className="sw-actions">
                <button className="sw-btn primary" disabled={saving} onClick={() => void handleSave()}>
                  <Timer size={14} />
                  {copy.check.saveSettings}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "status" ? (
          <div className="sw-tab-panel">
            <h4>{copy.status.title}</h4>
            <p className="sw-help">{copy.status.detail}</p>

            <div className="sw-status-grid">
              <div>
                <span className="sw-status-label">{copy.status.accounts}</span>
                <strong>{accounts.length}</strong>
              </div>
              <div>
                <span className="sw-status-label">{copy.status.enabledAccounts}</span>
                <strong>{wechatAccountsStatus.enabledCount}</strong>
              </div>
              <div>
                <span className="sw-status-label">{copy.status.verifiedAccounts}</span>
                <strong>{wechatAccountsStatus.verifiedCount}</strong>
              </div>
              <div>
                <span className="sw-status-label">{copy.status.alertStatus}</span>
                <strong>{status?.enabled && status.configured ? copy.status.enabled : copy.status.disabled}</strong>
              </div>
            </div>

            {selectedDeliveryCopy ? (
              <div className={`sw-delivery-banner severity-${selectedConnector?.delivery.severity}`}>
                <div className="sw-delivery-copy">
                  <strong>{selectedDeliveryCopy.title}</strong>
                  <p>{selectedDeliveryCopy.detail}</p>
                  {selectedDeliveryCopy.action ? <p className="sw-delivery-action">{selectedDeliveryCopy.action}</p> : null}
                </div>
              </div>
            ) : null}

            {selectedChecklist.length > 0 ? (
              <div className="sw-checklist">
                {selectedChecklist.map((item) => (
                  <div key={item.id} className={`sw-checklist-item state-${item.state}`}>
                    <span className="sw-checklist-icon" aria-hidden="true">
                      {item.state === "done" ? "✓" : item.state === "error" ? "!" : item.state === "active" ? "…" : "○"}
                    </span>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {accounts.length > 0 ? (
              <div className="sw-recipients-summary">
                <span className="sw-status-label">{copy.status.activeRecipients}</span>
                <div className="sw-recipients-chips">
                  {accounts.map((account) => (
                    <button
                      key={account.id}
                      className={`sw-recipient-chip${account.enabled && account.verified ? " active" : ""}`}
                      onClick={() => {
                        setSelectedAccountId(account.id);
                        setActiveTab("connection");
                      }}
                    >
                      {account.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="sw-actions">
              <button className="sw-btn ghost" disabled={saving} onClick={() => void onRefreshWeChatAccounts()}>
                <RefreshCw size={14} />
                {copy.refreshStatus}
              </button>
              <button className="sw-btn ghost" disabled={saving} onClick={() => void handleSave()}>
                {copy.status.saveSettings}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProxyToggle({
  title,
  detail,
  configured,
  enabled,
  configuredLabel,
  missingLabel,
  disabled,
  onChange
}: {
  title: string;
  detail: string;
  configured: boolean;
  enabled: boolean;
  configuredLabel: string;
  missingLabel: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const active = configured && enabled;
  return (
    <div className={`sw-proxy-card${active ? " active" : ""}${!configured ? " missing" : ""}`}>
      <div className="sw-proxy-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="sw-proxy-control">
        <span className={`sw-proxy-state${configured ? " configured" : " missing"}`}>
          {configured ? configuredLabel : missingLabel}
        </span>
        <label className="sw-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="sw-toggle-track">
            <span className="sw-toggle-thumb" />
          </span>
        </label>
      </div>
    </div>
  );
}

function accountStatusLabel(
  account: WeChatAccountConnectorStatus,
  copy: (typeof COPY)[keyof typeof COPY]
): string {
  if (account.verified) return copy.accounts.verified;
  if (account.connector.loggedIn) return copy.accounts.loggedIn;
  if (account.connector.awaitingQr || account.connector.qrUrl) return copy.accounts.waitingScan;
  if (account.connector.lastError) return copy.accounts.error;
  return copy.accounts.notConnected;
}

function getContextRefreshTarget(account: WeChatAccountConnectorStatus): string | null {
  if (account.connector.delivery.phase !== "context_stale") return null;
  return (
    account.connector.target?.userId ??
    account.alertTargetUserId ??
    account.connector.storedSession.contextUserIds[0] ??
    null
  );
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "-";
}

const COPY = {
  en: {
    title: "WeChat Alert Settings",
    tabsLabel: "Settings sections",
    refreshStatus: "Refresh",
    tabs: {
      recipients: "Recipients",
      connection: "Connection",
      check: "Connection Check",
      status: "Status"
    },
    common: {
      confirm: "Confirm",
      cancel: "Cancel"
    },
    accounts: {
      title: "Alert Recipients",
      detail: "Each recipient signs in with their own WeChat ClawBot account. Alerts are sent to every enabled, verified account.",
      add: "Add",
      addFirst: "Add first recipient",
      empty: "No recipients configured yet.",
      labelField: "Display Name",
      saveAccount: "Save recipient",
      edit: "Edit recipient",
      remove: "Remove recipient",
      connection: "Open connection",
      test: "Send test alert",
      testing: "Sending test alert…",
      testAll: "Test all",
      enabled: "Receiving alerts",
      disabled: "Alerts paused",
      added: "Added",
      target: "Verified target",
      pendingBotId: "WeChat account pending",
      needsVerification: "Logged in, waiting for verification message.",
      contextRefreshRequired: "Refresh context_token for",
      verified: "Verified",
      loggedIn: "Logged in",
      waitingScan: "Waiting for scan",
      error: "Connection error",
      notConnected: "Not connected",
      globalSettings: "Alert Settings",
      globalAlertDelivery: "Alert Delivery",
      globalAlertDeliveryHelp: "Master switch for WeChat alert delivery.",
      globalAlertEnabled: "Delivery enabled",
      globalAlertDisabled: "Delivery disabled",
      language: "Alert Language",
      cooldown: "Alert Interval (min)",
      cooldownHelp: "Minimum interval between auto alerts. Manual refresh always sends.",
      saveSettings: "Save Settings"
    },
    connection: {
      title: "Recipient Connection",
      detail: "Add a recipient from the first tab, then scan the QR code here to authorize that WeChat account.",
      selected: "Selected recipient",
      startLogin: "Generate login QR",
      refreshQr: "Refresh QR",
      fetchingQr: "Fetching login QR code…",
      restore: "Restore saved session",
      logout: "Log out",
      loggedIn: "WeChat account is connected.",
      verificationTitle: "Verify message token",
      contextHint: "After QR login, send any message from this WeChat account to ClawBot, then select the latest message to verify alert delivery.",
      waitingMessage: "Waiting for an inbound message…",
      detectMessages: "Detect messages",
      stepLogin: "QR login",
      stepMessage: "Send message",
      stepVerify: "Save token",
      latestMessage: "Latest detected message",
      verify: "Verify recipient",
      verified: "Verified delivery target:",
      contextRefreshTitle: "Manual context_token refresh required",
      contextRefreshAction: "Ask this WeChat user to send any message to ClawBot, then run Send test alert again.",
      contextRefreshTarget: "User to refresh",
      noPreview: "No text preview",
      empty: "Choose or add a recipient before connecting."
    },
    check: {
      title: "Connection Check Settings",
      detail: "Configure SSH timeouts used when refreshing server metrics and pipeline status.",
      connectTimeout: "SSH Connect Timeout (sec)",
      connectTimeoutHelp: "Maximum wait for the SSH handshake. Default: 10 seconds.",
      commandTimeout: "SSH Command Timeout (sec)",
      commandTimeoutHelp: "Maximum wait for metric collection commands. Default: 15 seconds.",
      hfProxyTitle: "Hugging Face Proxy",
      hfProxyDetail: "Proxy is used only when this switch is on and the matching .env URL is configured.",
      serverMonitorProxy: "Server Monitor",
      serverMonitorProxyHelp: "Dataset progress, repo checks, and repo creation.",
      solverProxy: "Remote Solver Upload",
      solverProxyHelp: "Exports proxy variables into solver tmux upload commands.",
      configured: ".env configured",
      notConfigured: ".env missing",
      saveSettings: "Save Settings"
    },
    status: {
      title: "Connection Status",
      detail: "Review WeChat account, verification, polling, and alert delivery status.",
      accounts: "Accounts",
      enabledAccounts: "Enabled",
      verifiedAccounts: "Verified",
      alertStatus: "Alerts",
      enabled: "Enabled",
      disabled: "Disabled",
      saveSettings: "Save Settings",
      activeRecipients: "Recipients"
    }
  },
  zh: {
    title: "微信告警设置",
    tabsLabel: "设置项",
    refreshStatus: "刷新",
    tabs: {
      recipients: "接收人",
      connection: "连接",
      check: "连接检查",
      status: "状态"
    },
    common: {
      confirm: "确认",
      cancel: "取消"
    },
    accounts: {
      title: "告警接收人",
      detail: "每个接收人用自己的微信 ClawBot 扫码登录。告警会发送给所有启用且已验证的账号。",
      add: "添加",
      addFirst: "添加第一个接收人",
      empty: "尚未配置接收人。",
      labelField: "显示名称",
      saveAccount: "保存接收人",
      edit: "编辑接收人",
      remove: "移除接收人",
      connection: "打开连接",
      test: "发送测试告警",
      testing: "正在发送测试告警…",
      testAll: "测试全部",
      enabled: "接收告警中",
      disabled: "告警已暂停",
      added: "添加于",
      target: "验证目标",
      pendingBotId: "微信账号待同步",
      needsVerification: "已登录，等待验证消息。",
      contextRefreshRequired: "需要刷新 context_token",
      verified: "已验证",
      loggedIn: "已登录",
      waitingScan: "等待扫码",
      error: "连接异常",
      notConnected: "未连接",
      globalSettings: "告警设置",
      globalAlertDelivery: "告警投递",
      globalAlertDeliveryHelp: "微信告警投递的全局开关。",
      globalAlertEnabled: "投递已启用",
      globalAlertDisabled: "投递未启用",
      language: "告警语言",
      cooldown: "告警间隔（分钟）",
      cooldownHelp: "自动检查的最小间隔。手动刷新始终发送。",
      saveSettings: "保存设置"
    },
    connection: {
      title: "接收人连接",
      detail: "先在第一个 tab 添加接收人，然后在这里扫描二维码授权该微信账号。",
      selected: "当前接收人",
      startLogin: "生成登录二维码",
      refreshQr: "刷新二维码",
      fetchingQr: "正在获取登录二维码…",
      restore: "恢复已保存会话",
      logout: "退出登录",
      loggedIn: "微信账号已连接。",
      verificationTitle: "验证消息并获取 contact token",
      contextHint: "扫码登录后，请用该微信账号给 ClawBot 发送任意消息，然后选择最新消息完成告警验证。",
      waitingMessage: "等待入站消息…",
      detectMessages: "检测消息",
      stepLogin: "扫码登录",
      stepMessage: "微信发消息",
      stepVerify: "保存 token",
      latestMessage: "最近检测到的消息",
      verify: "验证接收人",
      verified: "已验证投递目标：",
      contextRefreshTitle: "需要手动刷新 context_token",
      contextRefreshAction: "请让这个微信用户给 ClawBot 发任意一条消息，然后重新发送测试告警。",
      contextRefreshTarget: "需要操作的用户",
      noPreview: "无文本预览",
      empty: "请先选择或添加接收人。"
    },
    check: {
      title: "连接检查设置",
      detail: "配置刷新服务器指标与 Pipeline 状态时使用的 SSH 超时时间。",
      connectTimeout: "SSH 连接超时（秒）",
      connectTimeoutHelp: "等待 SSH 握手的最大时间。默认 10 秒。",
      commandTimeout: "SSH 命令超时（秒）",
      commandTimeoutHelp: "等待指标采集命令完成的最大时间。默认 15 秒。",
      hfProxyTitle: "Hugging Face 代理",
      hfProxyDetail: "只有这里开启，且 .env 中配置了对应 URL 时，才会使用代理。",
      serverMonitorProxy: "Server Monitor 后端",
      serverMonitorProxyHelp: "用于数据集进度、仓库检查和创建仓库。",
      solverProxy: "远端 Solver 上传",
      solverProxyHelp: "把代理变量写入远端 solver tmux 上传命令。",
      configured: ".env 已配置",
      notConfigured: ".env 未配置",
      saveSettings: "保存设置"
    },
    status: {
      title: "连接状态",
      detail: "查看微信账号、验证、轮询和告警投递状态。",
      accounts: "账号数",
      enabledAccounts: "已启用",
      verifiedAccounts: "已验证",
      alertStatus: "告警开关",
      enabled: "已启用",
      disabled: "未启用",
      saveSettings: "保存设置",
      activeRecipients: "接收人"
    }
  }
} as const;
