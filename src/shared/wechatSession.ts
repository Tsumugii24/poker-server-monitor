import type { WeChatConnectorStatus } from "./types";

export function defaultWeChatStoredSession(): WeChatConnectorStatus["storedSession"] {
  return {
    available: false,
    botUserId: null,
    savedAt: null,
    contextUserIds: [],
    verifiedForTarget: false
  };
}

export function hasWeChatMessageContext(
  status: Pick<WeChatConnectorStatus, "recentChats" | "messageCount" | "storedSession">,
  alertTargetUserId = ""
): boolean {
  if (status.recentChats.length > 0 || status.messageCount > 0) {
    return true;
  }

  const target = alertTargetUserId.trim();
  if (target && status.storedSession.contextUserIds.includes(target)) {
    return true;
  }

  return status.storedSession.contextUserIds.length > 0;
}

export function shouldOfferStoredSessionReuse(
  status: Pick<WeChatConnectorStatus, "loggedIn" | "storedSession">
): boolean {
  return !status.loggedIn && status.storedSession.available;
}
