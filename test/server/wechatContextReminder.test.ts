import { describe, expect, it } from "vitest";
import {
  formatWeChatContextRefreshReminderMessage,
  shouldSendWeChatContextRefreshReminder,
  WECHAT_CONTEXT_TOKEN_TTL_MS
} from "../../src/server/wechatContextReminder";

describe("wechatContextReminder", () => {
  const now = Date.parse("2026-06-25T12:00:00.000Z");

  it("sends inside the final hour before the 24h context window expires", () => {
    expect(shouldSendWeChatContextRefreshReminder({
      lastInboundAt: new Date(now - 23.5 * 60 * 60_000).toISOString()
    }, now)).toBe(true);
  });

  it("does not send before the reminder window", () => {
    expect(shouldSendWeChatContextRefreshReminder({
      lastInboundAt: new Date(now - 22 * 60 * 60_000).toISOString()
    }, now)).toBe(false);
  });

  it("does not send after the context window has expired", () => {
    expect(shouldSendWeChatContextRefreshReminder({
      lastInboundAt: new Date(now - WECHAT_CONTEXT_TOKEN_TTL_MS).toISOString()
    }, now)).toBe(false);
  });

  it("does not repeat a reminder for the same inbound context token", () => {
    const lastInboundAt = new Date(now - 23.5 * 60 * 60_000).toISOString();
    expect(shouldSendWeChatContextRefreshReminder({
      lastInboundAt,
      lastContextRefreshReminderAt: new Date(now - 5 * 60_000).toISOString()
    }, now)).toBe(false);
  });

  it("allows a reminder again after a new inbound message", () => {
    const lastInboundAt = new Date(now - 23.5 * 60 * 60_000).toISOString();
    expect(shouldSendWeChatContextRefreshReminder({
      lastInboundAt,
      lastContextRefreshReminderAt: new Date(now - 25 * 60 * 60_000).toISOString()
    }, now)).toBe(true);
  });

  it("formats the Chinese reactivation message", () => {
    expect(formatWeChatContextRefreshReminderMessage("zh", new Date(now))).toContain(
      "请向我发送任意消息来再次激活连接"
    );
  });
});
