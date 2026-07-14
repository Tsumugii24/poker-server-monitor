export const WECHAT_DELIVERY_PHASES = [
  "not_configured",
  "bot_offline",
  "awaiting_qr",
  "login_failed",
  "awaiting_context",
  "context_unverified",
  "ready",
  "context_stale",
  "send_error",
  "session_expired"
] as const;

export type WeChatDeliveryPhase = (typeof WECHAT_DELIVERY_PHASES)[number];

export type WeChatDeliverySeverity = "success" | "warning" | "error" | "info" | "neutral";

export type WeChatTargetActivity = {
  userId: string;
  lastInboundAt: string | null;
  lastSendSuccessAt: string | null;
  lastSendFailureAt: string | null;
  lastSendFailureCode: string | null;
};

export type WeChatDeliveryInfo = {
  phase: WeChatDeliveryPhase;
  severity: WeChatDeliverySeverity;
};

export type WeChatSendFailureCode =
  | "context_stale"
  | "no_context"
  | "session_expired"
  | "transport_error"
  | "unknown";

export type ClassifiedWeChatSendError = {
  code: WeChatSendFailureCode;
  message: string;
  logMessage: string;
};

export type ClassifiedWeChatStartupError = {
  message: string;
  logMessage: string;
};

export type WeChatDeliveryInput = {
  alertsConfigured: boolean;
  started: boolean;
  loggedIn: boolean;
  polling: boolean;
  ready: boolean;
  qrUrl: string | null;
  awaitingQr: boolean;
  lastError: string | null;
  target: WeChatTargetActivity | null;
  now?: number;
};

const CONTEXT_FRESH_MS = 24 * 60 * 60_000;
const CONTEXT_AGING_MS = 72 * 60 * 60_000;

export function classifyWeChatSendError(error: unknown): ClassifiedWeChatSendError {
  if (isNoContextError(error)) {
    return {
      code: "no_context",
      message: "No active WeChat session for this contact. Send a message to the bot first.",
      logMessage: "WeChat alert failed: no context_token for target (user must message the bot first)"
    };
  }

  if (isApiError(error)) {
    if (error.errcode === -14 || error.isSessionExpired) {
      return {
        code: "session_expired",
        message: "WeChat bot session expired. Restart login and scan the QR code again.",
        logMessage: "WeChat alert failed: bot session expired (errcode -14)"
      };
    }

    const ret = readRet(error);
    if (ret === -2) {
      return {
        code: "context_stale",
        message: "WeChat session token expired. Send any message to the bot to refresh delivery.",
        logMessage: "WeChat alert failed: context_token stale (ret=-2); ask the user to message the bot again"
      };
    }
  }

  if (isTransportError(error)) {
    return {
      code: "transport_error",
      message: "WeChat network error while sending the alert.",
      logMessage: `WeChat alert failed: transport error (${error instanceof Error ? error.message : String(error)})`
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "unknown",
    message,
    logMessage: `WeChat alert failed: ${message}`
  };
}

export function classifyWeChatStartupError(error: unknown): ClassifiedWeChatStartupError {
  if (error instanceof SyntaxError && /JSON|Unexpected end/i.test(error.message)) {
    return {
      message: "WeChat iLink returned an invalid JSON response. Check network or proxy access, then retry login.",
      logMessage: "WeChat connector login failed: invalid JSON response from iLink; check network or proxy access"
    };
  }

  if (isTimeoutError(error)) {
    return {
      message: "WeChat login timed out while contacting iLink. Check network access and retry login.",
      logMessage: "WeChat connector login failed: request timed out while contacting iLink"
    };
  }

  if (isTransportError(error)) {
    const detail = extractNetworkErrorCause(error);
    const hint = detail ? ` (${detail})` : "";
    return {
      message: buildTransportStartupMessage(detail),
      logMessage: `WeChat connector login failed: transport error (${error instanceof Error ? error.message : String(error)}${hint})`
    };
  }

  if (isAuthError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      logMessage: `WeChat connector login failed: ${message}`
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    logMessage: `WeChat connector login failed: ${message}`
  };
}

export function buildWeChatDelivery(input: WeChatDeliveryInput): WeChatDeliveryInfo {
  const now = input.now ?? Date.now();

  if (!input.alertsConfigured) {
    return { phase: "not_configured", severity: "neutral" };
  }

  if (!input.started) {
    return { phase: "bot_offline", severity: "warning" };
  }

  if (!input.loggedIn) {
    if (input.lastError) {
      return { phase: "login_failed", severity: "error" };
    }
    if (input.qrUrl || input.awaitingQr) {
      return { phase: "awaiting_qr", severity: "warning" };
    }
    return { phase: "bot_offline", severity: "warning" };
  }

  if (!input.polling || !input.ready) {
    return { phase: "bot_offline", severity: "warning" };
  }

  const target = input.target;
  if (!target) {
    return { phase: "awaiting_context", severity: "warning" };
  }

  const sendSucceeded = isMoreRecent(target.lastSendSuccessAt, target.lastSendFailureAt, now);
  if (sendSucceeded) {
    return { phase: "ready", severity: "success" };
  }

  if (target.lastSendFailureCode === "session_expired") {
    return { phase: "session_expired", severity: "error" };
  }

  if (target.lastSendFailureCode === "context_stale") {
    return { phase: "context_stale", severity: "error" };
  }

  if (target.lastSendFailureCode === "no_context") {
    return { phase: "awaiting_context", severity: "warning" };
  }

  if (target.lastSendFailureCode === "transport_error" || target.lastSendFailureCode === "unknown") {
    return { phase: "send_error", severity: "error" };
  }

  if (!target.lastInboundAt && !target.lastSendSuccessAt) {
    return { phase: "awaiting_context", severity: "warning" };
  }

  const inboundAge = ageMs(target.lastInboundAt, now);
  if (inboundAge != null && inboundAge <= CONTEXT_FRESH_MS) {
    return { phase: "ready", severity: "success" };
  }

  if (inboundAge != null && inboundAge <= CONTEXT_AGING_MS) {
    return { phase: "context_unverified", severity: "warning" };
  }

  if (target.lastInboundAt || target.lastSendSuccessAt) {
    return { phase: "context_unverified", severity: "warning" };
  }

  return { phase: "awaiting_context", severity: "warning" };
}

export type WeChatDeliveryCopy = {
  title: string;
  detail: string;
  action: string | null;
};

export function getWeChatDeliveryCopy(
  delivery: WeChatDeliveryInfo,
  language: "en" | "zh",
  target: WeChatTargetActivity | null
): WeChatDeliveryCopy {
  const copies = language === "zh" ? COPY_ZH : COPY_EN;
  const base = copies[delivery.phase];
  const targetHint = target?.userId
    ? language === "zh"
      ? `目标联系人：${formatTargetLabel(target.userId)}`
      : `Target contact: ${formatTargetLabel(target.userId)}`
    : null;

  return {
    title: base.title,
    detail: [base.detail, targetHint].filter(Boolean).join(" "),
    action: base.action
  };
}

export type WeChatChecklistStep = {
  id: string;
  title: string;
  detail: string;
  state: "done" | "active" | "pending" | "error";
};

export function buildWeChatChecklist(
  status: {
    loggedIn: boolean;
    polling: boolean;
    ready: boolean;
    delivery: WeChatDeliveryInfo;
    target: WeChatTargetActivity | null;
  },
  language: "en" | "zh"
): WeChatChecklistStep[] {
  const copy = language === "zh" ? CHECKLIST_ZH : CHECKLIST_EN;
  const contextDone = status.delivery.phase === "ready";
  const contextError = ["context_stale", "session_expired", "send_error"].includes(status.delivery.phase);
  const contextActive = ["awaiting_context", "context_unverified"].includes(status.delivery.phase);
  const deliveryDone = status.delivery.phase === "ready";
  const deliveryError = contextError;

  return [
    {
      id: "login",
      title: copy.login.title,
      detail: status.loggedIn ? copy.login.done : copy.login.pending,
      state: status.loggedIn ? "done" : status.delivery.phase === "login_failed" ? "error" : status.delivery.phase === "awaiting_qr" ? "active" : "pending"
    },
    {
      id: "polling",
      title: copy.polling.title,
      detail: status.polling && status.ready ? copy.polling.done : copy.polling.pending,
      state: status.polling && status.ready ? "done" : status.loggedIn ? "active" : "pending"
    },
    {
      id: "context",
      title: copy.context.title,
      detail: describeContextStep(status.target, language, contextDone, contextError),
      state: contextError ? "error" : contextDone ? "done" : contextActive ? "active" : "pending"
    },
    {
      id: "delivery",
      title: copy.delivery.title,
      detail: deliveryDone ? copy.delivery.done : deliveryError ? copy.delivery.error : copy.delivery.pending,
      state: deliveryError ? "error" : deliveryDone ? "done" : status.delivery.phase === "not_configured" ? "pending" : "active"
    }
  ];
}

function describeContextStep(
  target: WeChatTargetActivity | null,
  language: "en" | "zh",
  done: boolean,
  error: boolean
): string {
  if (done) {
    return language === "zh" ? "会话 token 可用，可主动发告警。" : "Session token is available for proactive alerts.";
  }
  if (error) {
    return language === "zh" ? "会话 token 已失效，需要重新激活。" : "Session token expired and must be refreshed.";
  }
  if (!target?.lastInboundAt) {
    return language === "zh"
      ? "请用目标微信给 Bot 发一条消息，以建立 context_token。"
      : "Send any message from the target WeChat account to the bot.";
  }
  const refreshed = formatRelativeTime(target.lastInboundAt, language);
  return language === "zh"
    ? `上次收到目标消息：${refreshed}。若告警失败，请再发一条消息刷新 token。`
    : `Last inbound from target: ${refreshed}. Send another message if alerts start failing.`;
}

function formatTargetLabel(userId: string): string {
  if (userId.endsWith("@chatroom")) return `${userId} (group)`;
  if (userId.endsWith("@im.wechat")) return `${userId} (direct message)`;
  return userId;
}

function formatRelativeTime(iso: string, language: "en" | "zh"): string {
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return iso;
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) {
    return language === "zh" ? `${minutes} 分钟前` : `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return language === "zh" ? `${hours} 小时前` : `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return language === "zh" ? `${days} 天前` : `${days} d ago`;
}

function isMoreRecent(successAt: string | null, failureAt: string | null, now: number): boolean {
  if (!successAt) return false;
  const successMs = Date.parse(successAt);
  if (!Number.isFinite(successMs)) return false;
  if (!failureAt) return true;
  const failureMs = Date.parse(failureAt);
  if (!Number.isFinite(failureMs)) return true;
  return successMs >= failureMs;
}

function ageMs(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, now - ms);
}

export function extractNetworkErrorCause(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const cause = current.cause;
    if (typeof cause === "object" && cause !== null) {
      const code = "code" in cause && typeof cause.code === "string" ? cause.code : null;
      const message = "message" in cause && typeof cause.message === "string" ? cause.message : null;
      if (code || message) {
        return [code, message].filter(Boolean).join(": ");
      }
    }
    current = cause;
  }

  return null;
}

function buildTransportStartupMessage(detail: string | null): string {
  if (detail?.includes("UND_ERR_INVALID_ARG") || detail?.includes("invalid content-length")) {
    return "WeChat login failed due to a Node.js fetch compatibility issue. Update @wechatbot/wechatbot or retry with Node 22 LTS.";
  }

  if (detail?.includes("ENOTFOUND") || detail?.includes("EAI_AGAIN")) {
    return "WeChat login failed: cannot resolve ilinkai.weixin.qq.com. Check DNS and retry login.";
  }

  if (detail?.includes("ECONNREFUSED") || detail?.includes("ECONNRESET") || detail?.includes("UND_ERR_CONNECT_TIMEOUT")) {
    return "WeChat login failed: connection to iLink was blocked or reset. Check firewall, VPN, or HTTP_PROXY settings.";
  }

  return "WeChat login failed due to a network error. Run `npm run wechat:check`, verify access to ilinkai.weixin.qq.com, then retry login.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNoContextError(error: unknown): boolean {
  return isRecord(error) && error.name === "NoContextError";
}

function isTransportError(error: unknown): boolean {
  return isRecord(error) && error.name === "TransportError";
}

function isAuthError(error: unknown): boolean {
  return isRecord(error) && error.name === "AuthError";
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  return isRecord(error) && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isApiError(error: unknown): error is Record<string, unknown> & { errcode?: number; isSessionExpired?: boolean } {
  return isRecord(error) && error.name === "ApiError";
}

function readRet(error: Record<string, unknown>): number | undefined {
  const payload = error.payload;
  if (isRecord(payload) && typeof payload.ret === "number") {
    return payload.ret;
  }
  return undefined;
}

const COPY_EN: Record<WeChatDeliveryPhase, WeChatDeliveryCopy> = {
  not_configured: {
    title: "Alerts not configured",
    detail: "Enable alerts and set a WeChat contact ID to monitor delivery readiness.",
    action: null
  },
  bot_offline: {
    title: "WeChat bot not ready",
    detail: "The bot is not logged in or polling has not started yet.",
    action: "Click “Start WeChat login”, scan the QR code, and wait until polling is running."
  },
  awaiting_qr: {
    title: "Waiting for QR scan",
    detail: "Login started. Scan the QR code with WeChat to continue.",
    action: "Open the QR link, complete login, then refresh status."
  },
  login_failed: {
    title: "WeChat login failed",
    detail: "The bot could not finish login. The dashboard keeps running, but alerts cannot be sent until login succeeds.",
    action: "Run `npm run wechat:check` on the server host, ensure ilinkai.weixin.qq.com is reachable, then click “Start WeChat login” again."
  },
  awaiting_context: {
    title: "Session token missing",
    detail: "The bot is online, but no valid context_token exists for the alert target yet.",
    action: "From the target WeChat account, send any message to the bot, then click “Send test alert”."
  },
  context_unverified: {
    title: "Session token may be aging",
    detail: "A token exists, but it has not been confirmed recently.",
    action: "Send a fresh message to the bot, or run “Send test alert” to verify delivery."
  },
  ready: {
    title: "Alert delivery ready",
    detail: "The bot can proactively send offline alerts to the configured contact.",
    action: null
  },
  context_stale: {
    title: "Session token expired",
    detail: "WeChat rejected the last send with ret=-2, which usually means the context_token expired.",
    action: "Send any message from the target account to the bot, then retry “Send test alert”."
  },
  send_error: {
    title: "Alert delivery failed",
    detail: "The last send attempt failed for a non-token reason.",
    action: "Check the last error below, refresh status, and retry the test alert."
  },
  session_expired: {
    title: "Bot session expired",
    detail: "The WeChat bot login session expired and must be renewed.",
    action: "Click “Start WeChat login” and scan the QR code again."
  }
};

const COPY_ZH: Record<WeChatDeliveryPhase, WeChatDeliveryCopy> = {
  not_configured: {
    title: "告警未配置",
    detail: "请先启用告警并填写微信联系人 ID，才能检查投递状态。",
    action: null
  },
  bot_offline: {
    title: "微信 Bot 未就绪",
    detail: "Bot 尚未登录，或消息轮询尚未启动。",
    action: "点击「Start WeChat login」扫码登录，并等待 Polling 变为 Running。"
  },
  awaiting_qr: {
    title: "等待扫码登录",
    detail: "登录流程已开始，请用微信扫描二维码。",
    action: "打开 QR 链接完成登录，然后点击 Refresh status。"
  },
  login_failed: {
    title: "微信登录失败",
    detail: "Bot 未能完成登录。监控面板仍可使用，但在登录成功前无法发送告警。",
    action: "请在服务器上运行 `npm run wechat:check`，确认能访问 ilinkai.weixin.qq.com，然后再次点击开始微信登录。"
  },
  awaiting_context: {
    title: "缺少会话 token",
    detail: "Bot 已在线，但告警目标还没有可用的 context_token。",
    action: "请用目标微信给 Bot 发任意一条消息，然后点击 Send test alert 验证。"
  },
  context_unverified: {
    title: "会话 token 可能已过期",
    detail: "检测到历史 token，但最近没有成功投递或新的入站消息确认。",
    action: "建议给 Bot 再发一条消息，或点击 Send test alert 验证。"
  },
  ready: {
    title: "告警投递正常",
    detail: "Bot 可以向已配置的联系人主动发送离线告警。",
    action: null
  },
  context_stale: {
    title: "会话 token 已失效",
    detail: "最近一次发送被微信以 ret=-2 拒绝，通常表示 context_token 已过期。",
    action: "请用目标微信给 Bot 发任意一条消息刷新 token，然后重试 Send test alert。"
  },
  send_error: {
    title: "告警发送失败",
    detail: "最近一次发送失败，且原因不是 token 过期。",
    action: "查看下方 Last error，刷新状态后重试 Send test alert。"
  },
  session_expired: {
    title: "Bot 登录会话过期",
    detail: "微信 Bot 登录态已失效，需要重新登录。",
    action: "点击 Start WeChat login 并重新扫码。"
  }
};

const CHECKLIST_EN = {
  login: { title: "Bot login", done: "Logged in.", pending: "Scan the QR code to log in." },
  polling: { title: "Message polling", done: "Listening for inbound messages.", pending: "Waiting for polling to start." },
  context: { title: "Session context", done: "Context token available.", pending: "Waiting for target message." },
  delivery: {
    title: "Alert delivery",
    done: "Recent send path is healthy.",
    pending: "Run a test alert after the steps above.",
    error: "Last delivery attempt failed."
  }
};

const CHECKLIST_ZH = {
  login: { title: "Bot 登录", done: "已登录。", pending: "请扫码登录。" },
  polling: { title: "消息轮询", done: "正在监听入站消息。", pending: "等待轮询启动。" },
  context: { title: "会话 Context", done: "context_token 可用。", pending: "等待目标账号发消息。" },
  delivery: {
    title: "告警投递",
    done: "最近投递路径正常。",
    pending: "完成前面步骤后发送测试告警。",
    error: "最近一次投递失败。"
  }
};
