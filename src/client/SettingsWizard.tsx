import { LogOut, Plus, RefreshCw, Send, Settings, Trash2, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AlertSettings, AlertStatus, WeChatConnectorStatus, WeChatRecipient } from "../shared/types";
import {
  buildWeChatChecklist,
  getWeChatDeliveryCopy
} from "../shared/wechatDelivery";
import {
  hasWeChatMessageContext,
  shouldOfferStoredSessionReuse
} from "../shared/wechatSession";
import { WeChatQrPanel } from "./WeChatQrPanel";

/* ── Tab types ────────────────────────────────────────────────── */
type SettingsTab = "connection" | "recipients" | "status";

type SessionChoice = "pending" | "reuse" | "new";

/* ── Props ────────────────────────────────────────────────────── */
type SettingsWizardProps = {
  settings: AlertSettings;
  status: AlertStatus | null;
  saving: boolean;
  wechatStatus: WeChatConnectorStatus;
  onClose: () => void;
  onSave: (settings: AlertSettings) => Promise<void>;
  onTest: (settings: AlertSettings) => Promise<void>;
  onStartWeChat: () => Promise<void>;
  onRefreshWeChat: () => Promise<void>;
  onRestoreWeChat: () => Promise<void>;
  onLogoutWeChat: () => Promise<void>;
  onSwitchWeChat: () => Promise<void>;
  onAddRecipient: (contactId: string, label: string) => Promise<void>;
  onUpdateRecipient: (id: string, patch: { enabled?: boolean; label?: string }) => Promise<void>;
  onRemoveRecipient: (id: string) => Promise<void>;
  onTestRecipient: (id: string) => Promise<void>;
};

/* ── Component ────────────────────────────────────────────────── */
export function SettingsWizard({
  settings,
  status,
  saving,
  wechatStatus,
  onClose,
  onSave,
  onTest,
  onStartWeChat,
  onRefreshWeChat,
  onRestoreWeChat,
  onLogoutWeChat,
  onSwitchWeChat,
  onAddRecipient,
  onUpdateRecipient,
  onRemoveRecipient,
  onTestRecipient
}: SettingsWizardProps) {
  const [draft, setDraft] = useState<AlertSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => deriveInitialTab(wechatStatus));
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"logout" | "switch" | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [sessionChoice, setSessionChoice] = useState<SessionChoice | null>(
    () => initialSessionChoice(wechatStatus)
  );

  /* ── Add-recipient form state ───────────────────────────────── */
  const [addContactId, setAddContactId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addingRecipient, setAddingRecipient] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  /* ── Delete confirmation state ──────────────────────────────── */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const language = draft.language ?? "en";
  const copy = COPY[language];
  const deliveryCopy = getWeChatDeliveryCopy(wechatStatus.delivery, language, wechatStatus.target);
  const checklist = buildWeChatChecklist(wechatStatus, language);
  const offerStoredSession = shouldOfferStoredSessionReuse(wechatStatus);

  /* ── Sync draft with external settings ──────────────────────── */
  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  /* ── Session choice initialization ──────────────────────────── */
  useEffect(() => {
    if (sessionChoice != null) return;
    setSessionChoice(initialSessionChoice(wechatStatus));
  }, [sessionChoice, wechatStatus]);

  /* ── Auto-advance from connection tab when logged in ────────── */
  useEffect(() => {
    if (sessionChoice === "pending") return;
    if (!wechatStatus.loggedIn || activeTab !== "connection" || wechatStatus.awaitingQr) return;
    // Don't auto-advance, let user explore
  }, [sessionChoice, wechatStatus.loggedIn, activeTab, wechatStatus.awaitingQr]);

  /* ── Derived state ──────────────────────────────────────────── */
  const hasContext = hasWeChatMessageContext(wechatStatus, draft.wechatRoomId);
  const showStoredSessionPrompt = sessionChoice === "pending" && offerStoredSession;
  const showQr = sessionChoice === "new" && Boolean(wechatStatus.qrUrl) && !wechatStatus.loggedIn;
  const waitingForQr =
    sessionChoice === "new" &&
    !wechatStatus.loggedIn &&
    wechatStatus.awaitingQr &&
    !wechatStatus.qrUrl &&
    !wechatStatus.lastError;
  const restoringSession = sessionChoice === "reuse" && !wechatStatus.loggedIn && !wechatStatus.lastError;
  const loginFailed = !wechatStatus.loggedIn && Boolean(wechatStatus.lastError) && !wechatStatus.awaitingQr;

  /* ── Tab configuration ──────────────────────────────────────── */
  const tabs: Array<{ id: SettingsTab; label: string; badge?: string }> = useMemo(() => [
    {
      id: "connection",
      label: copy.tabs.connection,
      badge: wechatStatus.loggedIn ? "●" : undefined
    },
    {
      id: "recipients",
      label: copy.tabs.recipients,
      badge: settings.wechatRecipients.filter((r) => r.enabled).length > 0
        ? String(settings.wechatRecipients.filter((r) => r.enabled).length)
        : undefined
    },
    {
      id: "status",
      label: copy.tabs.status
    }
  ], [copy, wechatStatus.loggedIn, settings.wechatRecipients]);

  /* ── Handlers ───────────────────────────────────────────────── */
  const handleSave = async () => {
    setActionError(null);
    try {
      await onSave({ ...draft, enabled: true, cooldownMinutes: Math.max(1, draft.cooldownMinutes) });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const resetAfterAccountChange = () => {
    setConfirmAction(null);
    setSessionChoice("new");
    setActiveTab("connection");
  };

  const handleRestoreSession = async () => {
    setAccountBusy(true);
    setActionError(null);
    setSessionChoice("reuse");
    try {
      await onRestoreWeChat();
    } catch (error) {
      setSessionChoice("pending");
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  };

  const handleNewSession = async () => {
    setAccountBusy(true);
    setActionError(null);
    setSessionChoice("new");
    try {
      await onSwitchWeChat();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  };

  const handleAccountAction = async (action: "logout" | "switch") => {
    setAccountBusy(true);
    setActionError(null);
    try {
      if (action === "logout") {
        await onLogoutWeChat();
      } else {
        await onSwitchWeChat();
      }
      resetAfterAccountChange();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  };

  const handleAddRecipient = async () => {
    if (!addContactId.trim()) return;
    setAddingRecipient(true);
    setActionError(null);
    try {
      await onAddRecipient(addContactId.trim(), addLabel.trim() || addContactId.trim());
      setAddContactId("");
      setAddLabel("");
      setShowAddForm(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingRecipient(false);
    }
  };

  const handleRemoveRecipient = async (id: string) => {
    setActionError(null);
    try {
      await onRemoveRecipient(id);
      setConfirmDeleteId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleRecipient = async (id: string, enabled: boolean) => {
    setActionError(null);
    try {
      await onUpdateRecipient(id, { enabled });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleTestRecipient = async (id: string) => {
    setTestingId(id);
    setActionError(null);
    try {
      await onTestRecipient(id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setTestingId(null);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */
  return (
    <section
      className="panel settings-panel settings-wizard"
      aria-label="Settings"
      role="dialog"
      aria-modal="true"
    >
      {/* Header */}
      <div className="sw-header">
        <div className="sw-header-left">
          <Settings size={16} />
          <h3>{copy.title}</h3>
        </div>
        <button className="sw-close-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {/* Tab Navigation */}
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

      {/* Error banner */}
      {actionError ? <div className="notice error sw-notice">{actionError}</div> : null}

      {/* Account card (shown when logged in, on connection tab) */}
      {wechatStatus.loggedIn && activeTab === "connection" ? (
        <div className="sw-account-card">
          <div className="sw-account-main">
            <div className="sw-account-avatar">
              <UserRound size={18} />
            </div>
            <div className="sw-account-info">
              <span className="sw-account-label">{copy.account.loggedInAs}</span>
              <strong>{wechatStatus.botUserId ?? copy.account.unknownUser}</strong>
            </div>
          </div>
          {confirmAction ? (
            <div className="sw-account-confirm">
              <p>{confirmAction === "logout" ? copy.account.confirmLogout : copy.account.confirmSwitch}</p>
              <div className="sw-actions">
                <button className="sw-btn danger" disabled={accountBusy || saving} onClick={() => void handleAccountAction(confirmAction)}>
                  {copy.account.confirm}
                </button>
                <button className="sw-btn ghost" disabled={accountBusy || saving} onClick={() => setConfirmAction(null)}>
                  {copy.account.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div className="sw-account-actions">
              <button className="sw-btn-icon" disabled={accountBusy || saving} onClick={() => setConfirmAction("switch")} title={copy.account.switch}>
                <RefreshCw size={14} />
              </button>
              <button className="sw-btn-icon danger" disabled={accountBusy || saving} onClick={() => setConfirmAction("logout")} title={copy.account.logout}>
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* Tab Content */}
      <div className="sw-body">
        {/* ── Connection Tab ─────────────────────────────────── */}
        {activeTab === "connection" ? (
          <div className="sw-tab-panel">
            {showStoredSessionPrompt ? (
              <>
                <h4>{copy.session.title}</h4>
                <p className="sw-help">{copy.session.detail}</p>
                <div className="sw-session-card">
                  <div className="sw-session-meta">
                    <div>
                      <span className="sw-meta-label">{copy.session.account}</span>
                      <strong>{wechatStatus.storedSession.botUserId ?? copy.account.unknownUser}</strong>
                    </div>
                    {wechatStatus.storedSession.savedAt ? (
                      <div>
                        <span className="sw-meta-label">{copy.session.savedAt}</span>
                        <strong>{formatDate(wechatStatus.storedSession.savedAt)}</strong>
                      </div>
                    ) : null}
                    {wechatStatus.storedSession.contextUserIds.length > 0 ? (
                      <div>
                        <span className="sw-meta-label">{copy.session.contextCount}</span>
                        <strong>{wechatStatus.storedSession.contextUserIds.length}</strong>
                      </div>
                    ) : null}
                  </div>
                  {wechatStatus.storedSession.verifiedForTarget ? (
                    <div className="sw-inline-success">{copy.session.verifiedTarget}</div>
                  ) : wechatStatus.storedSession.contextUserIds.length > 0 ? (
                    <div className="sw-hint">{copy.session.hasContext}</div>
                  ) : (
                    <div className="sw-hint">{copy.session.loginOnly}</div>
                  )}
                  <div className="sw-actions">
                    <button className="sw-btn primary" disabled={accountBusy || saving} onClick={() => void handleRestoreSession()}>
                      {copy.session.reuse}
                    </button>
                    <button className="sw-btn ghost" disabled={accountBusy || saving} onClick={() => void handleNewSession()}>
                      {copy.session.useNew}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h4>{copy.connection.title}</h4>
                <p className="sw-help">{copy.connection.detail}</p>

                {wechatStatus.lastError && !wechatStatus.loggedIn ? (
                  <div className="notice error">{wechatStatus.lastError}</div>
                ) : null}

                {showQr ? (
                  <WeChatQrPanel url={wechatStatus.qrUrl!} language={language} />
                ) : waitingForQr ? (
                  <div className="sw-waiting">{copy.connection.fetchingQr}</div>
                ) : restoringSession ? (
                  <div className="sw-waiting">{copy.session.restoring}</div>
                ) : wechatStatus.loggedIn ? (
                  <div className="sw-inline-success">{copy.connection.loggedIn}</div>
                ) : loginFailed ? (
                  <div className="sw-actions">
                    <button className="sw-btn primary" disabled={saving || accountBusy} onClick={() => void onStartWeChat()}>
                      {copy.connection.retryLogin}
                    </button>
                  </div>
                ) : sessionChoice === "new" ? (
                  <div className="sw-actions">
                    <button className="sw-btn primary" disabled={saving || accountBusy} onClick={() => void onStartWeChat()}>
                      {copy.connection.startLogin}
                    </button>
                  </div>
                ) : null}

                {/* Context check hint */}
                {wechatStatus.loggedIn && !hasContext ? (
                  <div className="sw-context-hint">
                    <p className="sw-help">{copy.connection.contextHint}</p>
                    {wechatStatus.recentChats.length > 0 ? (
                      <div className="sw-recent-chats">
                        {wechatStatus.recentChats.map((chat) => (
                          <div key={chat.userId} className="sw-chat-item">
                            <strong>{chat.userId}</strong>
                            <span>{chat.text || copy.connection.noPreview}</span>
                            <span className="sw-chat-time">{formatDate(chat.receivedAt)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="sw-waiting">{copy.connection.waitingMessage}</div>
                    )}
                    <div className="sw-actions">
                      <button className="sw-btn ghost" disabled={saving} onClick={() => void onRefreshWeChat()}>
                        <RefreshCw size={14} />
                        {copy.refreshStatus}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {/* ── Recipients Tab ─────────────────────────────────── */}
        {activeTab === "recipients" ? (
          <div className="sw-tab-panel">
            <div className="sw-recipients-header">
              <div>
                <h4>{copy.recipients.title}</h4>
                <p className="sw-help">{copy.recipients.detail}</p>
              </div>
              {!showAddForm ? (
                <button
                  className="sw-btn primary compact"
                  onClick={() => setShowAddForm(true)}
                  disabled={saving}
                >
                  <Plus size={14} />
                  {copy.recipients.add}
                </button>
              ) : null}
            </div>

            {/* Add recipient form */}
            {showAddForm ? (
              <div className="sw-add-form">
                <div className="sw-add-form-fields">
                  <div className="sw-field">
                    <label>{copy.recipients.contactId}</label>
                    <input
                      value={addContactId}
                      onChange={(e) => setAddContactId(e.target.value)}
                      placeholder="user_id or 12345@chatroom"
                      autoFocus
                    />
                  </div>
                  <div className="sw-field">
                    <label>{copy.recipients.labelField}</label>
                    <input
                      value={addLabel}
                      onChange={(e) => setAddLabel(e.target.value)}
                      placeholder={copy.recipients.labelPlaceholder}
                    />
                  </div>
                </div>
                {/* Auto-suggest from recent chats */}
                {wechatStatus.recentChats.length > 0 ? (
                  <div className="sw-suggestions">
                    <span className="sw-suggestions-label">{copy.recipients.suggestions}:</span>
                    {wechatStatus.recentChats.map((chat) => (
                      <button
                        key={chat.userId}
                        className="sw-suggestion-chip"
                        onClick={() => {
                          setAddContactId(chat.userId);
                          if (!addLabel) setAddLabel(chat.userId);
                        }}
                      >
                        {chat.userId}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="sw-add-form-actions">
                  <button
                    className="sw-btn primary compact"
                    disabled={addingRecipient || !addContactId.trim() || saving}
                    onClick={() => void handleAddRecipient()}
                  >
                    {addingRecipient ? copy.recipients.adding : copy.recipients.addBtn}
                  </button>
                  <button
                    className="sw-btn ghost compact"
                    onClick={() => { setShowAddForm(false); setAddContactId(""); setAddLabel(""); }}
                    disabled={addingRecipient}
                  >
                    {copy.account.cancel}
                  </button>
                </div>
              </div>
            ) : null}

            {/* Recipient list */}
            {settings.wechatRecipients.length > 0 ? (
              <div className="sw-recipient-list">
                {settings.wechatRecipients.map((recipient) => (
                  <div key={recipient.id} className={`sw-recipient-card${recipient.enabled ? " enabled" : " disabled"}`}>
                    <div className="sw-recipient-main">
                      <div className="sw-recipient-info">
                        <strong className="sw-recipient-label">{recipient.label}</strong>
                        {recipient.label !== recipient.contactId ? (
                          <span className="sw-recipient-contact">{recipient.contactId}</span>
                        ) : null}
                        <span className="sw-recipient-date">
                          {copy.recipients.added} {formatDate(recipient.addedAt)}
                        </span>
                      </div>
                      <div className="sw-recipient-controls">
                        {/* Toggle switch */}
                        <label className="sw-toggle" title={recipient.enabled ? copy.recipients.enabled : copy.recipients.disabled}>
                          <input
                            type="checkbox"
                            checked={recipient.enabled}
                            onChange={(e) => void handleToggleRecipient(recipient.id, e.target.checked)}
                            disabled={saving}
                          />
                          <span className="sw-toggle-track">
                            <span className="sw-toggle-thumb" />
                          </span>
                        </label>
                        {/* Test button */}
                        <button
                          className="sw-btn-icon"
                          disabled={saving || testingId === recipient.id || !recipient.enabled}
                          onClick={() => void handleTestRecipient(recipient.id)}
                          title={copy.recipients.test}
                        >
                          <Send size={13} />
                        </button>
                        {/* Delete button */}
                        {confirmDeleteId === recipient.id ? (
                          <div className="sw-delete-confirm">
                            <button
                              className="sw-btn danger compact"
                              onClick={() => void handleRemoveRecipient(recipient.id)}
                              disabled={saving}
                            >
                              {copy.account.confirm}
                            </button>
                            <button
                              className="sw-btn ghost compact"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              {copy.account.cancel}
                            </button>
                          </div>
                        ) : (
                          <button
                            className="sw-btn-icon danger"
                            onClick={() => setConfirmDeleteId(recipient.id)}
                            disabled={saving}
                            title={copy.recipients.remove}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    {testingId === recipient.id ? (
                      <div className="sw-recipient-testing">{copy.recipients.testing}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : !showAddForm ? (
              <div className="sw-empty-state">
                <p>{copy.recipients.empty}</p>
                <button className="sw-btn primary" onClick={() => setShowAddForm(true)}>
                  <Plus size={14} />
                  {copy.recipients.addFirst}
                </button>
              </div>
            ) : null}

            {/* Global settings */}
            <div className="sw-global-settings">
              <h4>{copy.recipients.globalSettings}</h4>
              <div className="sw-settings-grid">
                <div className="sw-field">
                  <label>{copy.recipients.language}</label>
                  <select
                    value={draft.language ?? "en"}
                    onChange={(e) => setDraft((c) => ({ ...c, language: e.target.value === "zh" ? "zh" : "en" }))}
                  >
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                  </select>
                </div>
                <div className="sw-field">
                  <label>{copy.recipients.cooldown}</label>
                  <input
                    type="number"
                    min="1"
                    value={draft.cooldownMinutes || ""}
                    onChange={(e) => setDraft((c) => ({
                      ...c,
                      cooldownMinutes: e.target.value === "" ? 0 : Math.max(1, Number(e.target.value) || 1)
                    }))}
                  />
                  <span className="sw-field-hint">{copy.recipients.cooldownHelp}</span>
                </div>
              </div>
              <div className="sw-actions">
                <button className="sw-btn primary" disabled={saving} onClick={() => void handleSave()}>
                  {copy.recipients.saveSettings}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Status Tab ─────────────────────────────────────── */}
        {activeTab === "status" ? (
          <div className="sw-tab-panel">
            <h4>{copy.status.title}</h4>
            <p className="sw-help">{copy.status.detail}</p>

            {/* Delivery banner */}
            <div className={`sw-delivery-banner severity-${wechatStatus.delivery.severity}`}>
              <div className="sw-delivery-copy">
                <strong>{deliveryCopy.title}</strong>
                <p>{deliveryCopy.detail}</p>
                {deliveryCopy.action ? <p className="sw-delivery-action">{deliveryCopy.action}</p> : null}
              </div>
            </div>

            {/* Checklist */}
            <div className="sw-checklist">
              {checklist.map((item) => (
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

            {/* Status grid */}
            <div className="sw-status-grid">
              <div>
                <span className="sw-status-label">{copy.status.botLogin}</span>
                <strong>{wechatStatus.loggedIn ? copy.status.online : copy.status.offline}</strong>
              </div>
              <div>
                <span className="sw-status-label">{copy.status.polling}</span>
                <strong>{wechatStatus.polling && wechatStatus.ready ? copy.status.running : copy.status.stopped}</strong>
              </div>
              <div>
                <span className="sw-status-label">{copy.status.alertStatus}</span>
                <strong>{status?.enabled && status.configured ? copy.status.enabled : copy.status.disabled}</strong>
              </div>
              <div>
                <span className="sw-status-label">{copy.status.delivery}</span>
                <strong>{deliveryCopy.title}</strong>
              </div>
              {wechatStatus.target ? (
                <>
                  <div>
                    <span className="sw-status-label">{copy.status.botAccount}</span>
                    <strong>{wechatStatus.botUserId ?? "-"}</strong>
                  </div>
                  <div>
                    <span className="sw-status-label">{copy.status.lastInbound}</span>
                    <strong>{formatDate(wechatStatus.target.lastInboundAt)}</strong>
                  </div>
                  <div>
                    <span className="sw-status-label">{copy.status.lastSuccess}</span>
                    <strong>{formatDate(wechatStatus.target.lastSendSuccessAt)}</strong>
                  </div>
                </>
              ) : wechatStatus.botUserId ? (
                <div>
                  <span className="sw-status-label">{copy.status.botAccount}</span>
                  <strong>{wechatStatus.botUserId}</strong>
                </div>
              ) : null}
              {wechatStatus.lastError ? (
                <div className="sw-status-span-2">
                  <span className="sw-status-label">{copy.status.lastError}</span>
                  <strong className="sw-error-text">{wechatStatus.lastError}</strong>
                </div>
              ) : null}
            </div>

            {/* Recipients summary */}
            {settings.wechatRecipients.length > 0 ? (
              <div className="sw-recipients-summary">
                <span className="sw-status-label">{copy.status.activeRecipients}</span>
                <div className="sw-recipients-chips">
                  {settings.wechatRecipients.map((r) => (
                    <span key={r.id} className={`sw-recipient-chip${r.enabled ? " active" : ""}`}>
                      {r.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="sw-actions">
              <button className="sw-btn ghost" disabled={saving} onClick={() => void onRefreshWeChat()}>
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

/* ── Helpers ──────────────────────────────────────────────────── */

function initialSessionChoice(wechatStatus: WeChatConnectorStatus): SessionChoice {
  if (wechatStatus.loggedIn) return "reuse";
  if (shouldOfferStoredSessionReuse(wechatStatus)) return "pending";
  return "new";
}

function deriveInitialTab(wechatStatus: WeChatConnectorStatus): SettingsTab {
  if (!wechatStatus.loggedIn) return "connection";
  return "recipients";
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "-";
}

/* ── Bilingual copy ──────────────────────────────────────────── */
const COPY = {
  en: {
    title: "WeChat Alert Settings",
    tabsLabel: "Settings sections",
    tabs: {
      connection: "Connection",
      recipients: "Recipients",
      status: "Status"
    },
    refreshStatus: "Refresh",
    session: {
      title: "Previous session found",
      detail: "A saved bot login was detected. Reuse it to skip QR scan when the cached connection is still valid.",
      account: "Saved account",
      savedAt: "Last saved",
      contextCount: "Cached contacts",
      verifiedTarget: "Session matches your configured alert target.",
      hasContext: "Cached message sessions found. You can reuse this connection.",
      loginOnly: "Only login credentials cached. You may still need to send a setup message.",
      reuse: "Continue with saved session",
      useNew: "Sign in with another account",
      restoring: "Restoring saved session…"
    },
    account: {
      loggedInAs: "Logged in as",
      unknownUser: "WeChat bot (ID pending)",
      switch: "Switch account",
      logout: "Log out",
      confirm: "Confirm",
      cancel: "Cancel",
      confirmLogout: "Log out the current bot? Alert delivery will stop until you scan a new QR code.",
      confirmSwitch: "Switch to another account? You will need to scan a new QR code."
    },
    connection: {
      title: "Bot Connection",
      detail: "Start WeChat login, then scan the QR code with your phone to authorize the bot.",
      startLogin: "Start WeChat Login",
      retryLogin: "Retry Login",
      fetchingQr: "Fetching login QR code…",
      loggedIn: "Bot connected successfully.",
      contextHint: "Send any message from your WeChat to the bot to establish the session token for proactive alerts.",
      waitingMessage: "Waiting for an inbound message…",
      noPreview: "No text preview"
    },
    recipients: {
      title: "Notification Recipients",
      detail: "Manage WeChat accounts that receive alert notifications.",
      add: "Add",
      addFirst: "Add first recipient",
      addBtn: "Add recipient",
      adding: "Adding…",
      contactId: "WeChat Contact ID",
      labelField: "Display Name",
      labelPlaceholder: "e.g. Team Lead, Ops Room",
      suggestions: "Recent contacts",
      empty: "No recipients configured yet. Add a WeChat contact to start receiving alerts.",
      added: "Added",
      enabled: "Receiving alerts",
      disabled: "Alerts paused",
      test: "Send test alert",
      testing: "Sending test alert…",
      remove: "Remove recipient",
      globalSettings: "Alert Settings",
      language: "Alert Language",
      cooldown: "Alert Interval (min)",
      cooldownHelp: "Minimum interval between auto alerts. Manual refresh always sends.",
      saveSettings: "Save Settings"
    },
    status: {
      title: "Connection Status",
      detail: "Review bot login, polling, and alert delivery status.",
      botLogin: "Bot Login",
      botAccount: "Bot Account",
      polling: "Polling",
      alertStatus: "Alerts",
      delivery: "Delivery",
      online: "Connected",
      offline: "Disconnected",
      running: "Running",
      stopped: "Stopped",
      enabled: "Enabled",
      disabled: "Disabled",
      lastInbound: "Last Message",
      lastSuccess: "Last Sent",
      lastError: "Last Error",
      saveSettings: "Save Settings",
      activeRecipients: "Recipients"
    }
  },
  zh: {
    title: "微信告警设置",
    tabsLabel: "设置项",
    tabs: {
      connection: "连接",
      recipients: "接收人",
      status: "状态"
    },
    refreshStatus: "刷新",
    session: {
      title: "检测到已保存的会话",
      detail: "服务器上已有 Bot 登录缓存。若连接仍有效，复用后可跳过扫码步骤。",
      account: "已保存账号",
      savedAt: "上次保存",
      contextCount: "已缓存联系人",
      verifiedTarget: "缓存会话与当前配置的告警目标一致。",
      hasContext: "检测到已缓存的消息会话，可复用并继续。",
      loginOnly: "仅检测到登录凭证。复用后可能仍需发送消息建立会话。",
      reuse: "继续复用此会话",
      useNew: "登录新账号",
      restoring: "正在恢复会话…"
    },
    account: {
      loggedInAs: "当前登录",
      unknownUser: "微信 Bot（ID 同步中）",
      switch: "切换账号",
      logout: "退出登录",
      confirm: "确认",
      cancel: "取消",
      confirmLogout: "确定退出当前 Bot？退出后告警将暂停。",
      confirmSwitch: "确定切换账号？需重新扫码登录。"
    },
    connection: {
      title: "Bot 连接",
      detail: "启动微信登录后，用手机微信扫描二维码完成授权。",
      startLogin: "开始微信登录",
      retryLogin: "重试登录",
      fetchingQr: "正在获取登录二维码…",
      loggedIn: "Bot 已成功连接。",
      contextHint: "请用接收告警的微信账号给 Bot 发送任意一条消息，以建立会话。",
      waitingMessage: "等待入站消息…",
      noPreview: "无文本预览"
    },
    recipients: {
      title: "通知接收人",
      detail: "管理接收告警通知的微信账号。",
      add: "添加",
      addFirst: "添加第一个接收人",
      addBtn: "添加接收人",
      adding: "添加中…",
      contactId: "微信联系人 ID",
      labelField: "显示名称",
      labelPlaceholder: "例如：运维组、技术负责人",
      suggestions: "最近联系人",
      empty: "尚未配置接收人。添加微信联系人以开始接收告警。",
      added: "添加于",
      enabled: "接收告警中",
      disabled: "告警已暂停",
      test: "发送测试告警",
      testing: "正在发送测试告警…",
      remove: "移除接收人",
      globalSettings: "告警设置",
      language: "告警语言",
      cooldown: "告警间隔（分钟）",
      cooldownHelp: "自动检查的最小间隔。手动刷新始终发送。",
      saveSettings: "保存设置"
    },
    status: {
      title: "连接状态",
      detail: "查看 Bot 登录、轮询和告警投递状态。",
      botLogin: "Bot 登录",
      botAccount: "Bot 账号",
      polling: "消息轮询",
      alertStatus: "告警开关",
      delivery: "投递状态",
      online: "已连接",
      offline: "未连接",
      running: "运行中",
      stopped: "未运行",
      enabled: "已启用",
      disabled: "未启用",
      lastInbound: "最近消息",
      lastSuccess: "最近发送",
      lastError: "最近错误",
      saveSettings: "保存设置",
      activeRecipients: "接收人"
    }
  }
} as const;
