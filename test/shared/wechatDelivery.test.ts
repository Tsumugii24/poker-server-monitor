import { describe, expect, it } from "vitest";
import {
  buildWeChatDelivery,
  classifyWeChatSendError,
  classifyWeChatStartupError,
  getWeChatDeliveryCopy
} from "../../src/shared/wechatDelivery";

describe("wechatDelivery", () => {
  it("classifies ret=-2 as stale context token", () => {
    const classified = classifyWeChatSendError({
      name: "ApiError",
      message: "API error ret=-2 errcode=undefined",
      errcode: -2,
      payload: { ret: -2 }
    });

    expect(classified.code).toBe("context_stale");
    expect(classified.logMessage).toContain("ret=-2");
  });

  it("marks delivery ready after a recent successful send", () => {
    const delivery = buildWeChatDelivery({
      alertsConfigured: true,
      started: true,
      loggedIn: true,
      polling: true,
      ready: true,
      qrUrl: null,
      awaitingQr: false,
      lastError: null,
      now: Date.parse("2026-06-13T12:00:00.000Z"),
      target: {
        userId: "user@im.wechat",
        lastInboundAt: "2026-06-10T12:00:00.000Z",
        lastSendSuccessAt: "2026-06-13T11:30:00.000Z",
        lastSendFailureAt: "2026-06-13T10:00:00.000Z",
        lastSendFailureCode: "context_stale"
      }
    });

    expect(delivery.phase).toBe("ready");
    expect(delivery.severity).toBe("success");
  });

  it("marks delivery stale after ret=-2 failure", () => {
    const delivery = buildWeChatDelivery({
      alertsConfigured: true,
      started: true,
      loggedIn: true,
      polling: true,
      ready: true,
      qrUrl: null,
      awaitingQr: false,
      lastError: null,
      target: {
        userId: "user@im.wechat",
        lastInboundAt: "2026-06-12T12:00:00.000Z",
        lastSendSuccessAt: "2026-06-12T12:05:00.000Z",
        lastSendFailureAt: "2026-06-13T12:00:00.000Z",
        lastSendFailureCode: "context_stale"
      }
    });

    expect(delivery.phase).toBe("context_stale");
    expect(delivery.severity).toBe("error");
  });

  it("classifies login timeout errors", () => {
    const classified = classifyWeChatStartupError(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    );

    expect(classified.message).toContain("timed out");
    expect(classified.logMessage).toContain("timed out");
  });

  it("classifies transport errors with underlying cause details", () => {
    const classified = classifyWeChatStartupError(
      Object.assign(new Error("Network error: fetch failed"), {
        name: "TransportError",
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND ilinkai.weixin.qq.com"), { code: "ENOTFOUND" })
      })
    );

    expect(classified.message).toContain("cannot resolve");
    expect(classified.logMessage).toContain("ENOTFOUND");
  });

  it("marks login_failed when bot startup errored before login", () => {
    const delivery = buildWeChatDelivery({
      alertsConfigured: true,
      started: true,
      loggedIn: false,
      polling: false,
      ready: false,
      qrUrl: null,
      awaitingQr: false,
      lastError: "WeChat login timed out while contacting iLink. Check network access and retry login.",
      target: {
        userId: "user@im.wechat",
        lastInboundAt: null,
        lastSendSuccessAt: null,
        lastSendFailureAt: null,
        lastSendFailureCode: null
      }
    });

    expect(delivery.phase).toBe("login_failed");
  });
});
