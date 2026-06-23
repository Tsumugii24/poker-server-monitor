import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultWeChatStoredSession as defaultStoredSession } from "../shared/wechatSession";
import type { WeChatStoredSession } from "../shared/types";

type StoredCredentials = {
  userId?: string;
  savedAt?: string;
};

export function defaultWeChatStoredSession(): WeChatStoredSession {
  return defaultStoredSession();
}

export function readStoredWeChatSession(
  alertTargetUserId = "",
  storageDir = path.join(os.homedir(), ".wechatbot")
): WeChatStoredSession {
  const credentials = readJsonFile<StoredCredentials>(path.join(storageDir, "credentials.json"));
  if (!credentials?.userId) {
    return defaultWeChatStoredSession();
  }

  const contextTokens = readJsonFile<Record<string, string>>(path.join(storageDir, "context_tokens.json"));
  const contextUserIds = contextTokens ? Object.keys(contextTokens).filter(Boolean).sort() : [];
  const configuredTarget = alertTargetUserId.trim();

  return {
    available: true,
    botUserId: credentials.userId,
    savedAt: credentials.savedAt ?? null,
    contextUserIds,
    verifiedForTarget: configuredTarget.length > 0 && contextUserIds.includes(configuredTarget)
  };
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
