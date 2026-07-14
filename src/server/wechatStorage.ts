import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultWeChatStoredSession as defaultStoredSession } from "../shared/wechatSession";
import type { WeChatStoredSession } from "../shared/types";

type StoredCredentials = {
  userId?: string;
  savedAt?: string;
};

const WECHAT_SDK_STORAGE_FILES = [
  "credentials.json",
  "cursor.json",
  "context_tokens.json",
  "typing_tickets.json"
] as const;

export type WeChatStorageRepair = {
  filePath: string;
  backupPath: string;
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

export function quarantineInvalidWeChatStorage(
  storageDir = path.join(os.homedir(), ".wechatbot"),
  now = Date.now()
): WeChatStorageRepair[] {
  const repairs: WeChatStorageRepair[] = [];
  for (const filename of WECHAT_SDK_STORAGE_FILES) {
    const filePath = path.join(storageDir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      const backupPath = availableBackupPath(filePath, now);
      fs.renameSync(filePath, backupPath);
      repairs.push({ filePath, backupPath });
    }
  }
  return repairs;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function availableBackupPath(filePath: string, now: number): string {
  const base = `${filePath}.corrupt-${now}`;
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
