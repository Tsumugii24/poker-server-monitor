import { describe, expect, it } from "vitest";
import {
  defaultWeChatStoredSession,
  hasWeChatMessageContext,
  shouldOfferStoredSessionReuse
} from "../../src/shared/wechatSession";

describe("wechatSession", () => {
  it("offers reuse when a stored session exists and bot is offline", () => {
    expect(shouldOfferStoredSessionReuse({
      loggedIn: false,
      storedSession: {
        ...defaultWeChatStoredSession(),
        available: true,
        botUserId: "bot@im.wechat"
      }
    })).toBe(true);
  });

  it("detects cached message context from stored tokens", () => {
    expect(hasWeChatMessageContext({
      recentChats: [],
      messageCount: 0,
      storedSession: {
        ...defaultWeChatStoredSession(),
        available: true,
        contextUserIds: ["123@im.wechat"]
      }
    }, "123@im.wechat")).toBe(true);
  });
});
