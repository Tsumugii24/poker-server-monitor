import type { AlertSettings } from "../shared/types";

export const WECHAT_CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const WECHAT_CONTEXT_REMINDER_LEAD_MS = 60 * 60_000;

export type WeChatContextReminderActivity = {
  lastInboundAt: string | null;
  lastContextRefreshReminderAt?: string | null;
};

export type WeChatContextReminderOptions = {
  ttlMs?: number;
  leadMs?: number;
};

export function shouldSendWeChatContextRefreshReminder(
  activity: WeChatContextReminderActivity,
  now = Date.now(),
  options: WeChatContextReminderOptions = {}
): boolean {
  const ttlMs = options.ttlMs ?? WECHAT_CONTEXT_TOKEN_TTL_MS;
  const leadMs = options.leadMs ?? WECHAT_CONTEXT_REMINDER_LEAD_MS;
  const inboundMs = parseIsoMs(activity.lastInboundAt);
  if (inboundMs == null) return false;

  const ageMs = now - inboundMs;
  if (ageMs < ttlMs - leadMs || ageMs >= ttlMs) return false;

  const reminderMs = parseIsoMs(activity.lastContextRefreshReminderAt ?? null);
  return reminderMs == null || reminderMs < inboundMs;
}

export function formatWeChatContextRefreshReminderMessage(
  language: AlertSettings["language"],
  now = new Date()
): string {
  if (language === "zh") {
    return [
      "微信 ClawBot 连接即将失效",
      "",
      "当前告警连接将在约 24 小时未互动后失效。",
      "请向我发送任意消息来再次激活连接，以便继续接收 Server Monitor 告警。",
      "",
      `提醒时间: ${now.toLocaleString()}`
    ].join("\n");
  }

  return [
    "WeChat ClawBot connection will expire soon",
    "",
    "Alert delivery expires after about 24 hours without an inbound message.",
    "Please send me any message to reactivate the connection and keep receiving Server Monitor alerts.",
    "",
    `Reminder time: ${now.toLocaleString()}`
  ].join("\n");
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
