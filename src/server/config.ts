import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {
  DEFAULT_SSH_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS
} from "../shared/sshSettings";
import type { AlertSettings, ServerConfig, WeChatAccount, WeChatRecipient } from "../shared/types";

export type RuntimeConfig = {
  host: string;
  port: number;
  databasePath: string;
  refreshIntervalMs: number;
  inventoryPath: string;
  alertSettingsPath: string;
  pipelineStatusFilePath: string;
  ssh: {
    username: string;
    password: string;
  };
};

type EnvSource = Record<string, string | undefined>;

export function loadRuntimeConfig(env: EnvSource = process.env): RuntimeConfig {
  dotenv.config();

  const username = required(env.SSH_USERNAME, "SSH_USERNAME");
  const password = required(env.SSH_PASSWORD, "SSH_PASSWORD");

  return {
    host: env.SERVER_MONITOR_HOST ?? "127.0.0.1",
    port: numberFromEnv(env.SERVER_MONITOR_PORT, 3001),
    databasePath: env.SERVER_MONITOR_DB_PATH ?? "data/server-monitor.sqlite",
    refreshIntervalMs: numberFromEnv(env.SERVER_MONITOR_REFRESH_INTERVAL_MS, 3_600_000),
    inventoryPath: env.SERVER_MONITOR_INVENTORY_PATH ?? "config/servers.json",
    alertSettingsPath: env.SERVER_MONITOR_ALERT_SETTINGS_PATH ?? "config/alerts.json",
    pipelineStatusFilePath: env.PIPELINE_STATUS_FILE ?? "~/run/solver_running_status.json",
    ssh: {
      username,
      password
    }
  };
}

export function loadAlertSettings(filename = "config/alerts.json"): AlertSettings {
  const fullPath = path.resolve(filename);
  if (!fs.existsSync(fullPath)) {
    return defaultAlertSettings();
  }

  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error(`Alert settings must be an object: ${filename}`);
  }

  return normalizeAlertSettings(raw);
}

export function saveAlertSettings(filename: string, settings: AlertSettings): AlertSettings {
  const normalized = normalizeAlertSettings(settings);
  const fullPath = path.resolve(filename);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function loadServerInventory(filename = "config/servers.json"): ServerConfig[] {
  const fullPath = path.resolve(filename);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Server inventory must be an array: ${filename}`);
  }

  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Server inventory entry ${index} must be an object`);
    }

    const id = requiredString(item.id, `servers[${index}].id`);
    if (seen.has(id)) {
      throw new Error(`Duplicate server id ${id}`);
    }
    seen.add(id);

    const server: ServerConfig = {
      id,
      name: requiredString(item.name, `servers[${index}].name`),
      host: requiredString(item.host, `servers[${index}].host`),
      port: item.port == null ? 22 : requiredNumber(item.port, `servers[${index}].port`),
      enabled: item.enabled == null ? true : requiredBoolean(item.enabled, `servers[${index}].enabled`),
      note: item.note == null ? "TBD" : requiredString(item.note, `servers[${index}].note`)
    };

    if (item.group != null) {
      server.group = requiredString(item.group, `servers[${index}].group`);
    }

    return server;
  });
}

export function updateServerInventoryNote(
  filename: string,
  serverId: string,
  note: string
): ServerConfig {
  const trimmedNote = note.trim();
  if (trimmedNote === "") {
    throw new Error("note must be a non-empty string");
  }

  const fullPath = path.resolve(filename);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Server inventory must be an array: ${filename}`);
  }

  const entry = raw.find((item) => isRecord(item) && item.id === serverId);
  if (!entry || !isRecord(entry)) {
    throw new Error(`Server ${serverId} not found`);
  }

  entry.note = trimmedNote;
  fs.writeFileSync(fullPath, `${JSON.stringify(raw, null, 2)}\n`);

  const updated = loadServerInventory(fullPath).find((server) => server.id === serverId);
  if (!updated) {
    throw new Error(`Server ${serverId} not found`);
  }
  return updated;
}

export function updateServerInventoryName(
  filename: string,
  serverId: string,
  name: string
): ServerConfig {
  const trimmedName = name.trim();
  if (trimmedName === "") {
    throw new Error("name must be a non-empty string");
  }

  const fullPath = path.resolve(filename);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Server inventory must be an array: ${filename}`);
  }

  const entry = raw.find((item) => isRecord(item) && item.id === serverId);
  if (!entry || !isRecord(entry)) {
    throw new Error(`Server ${serverId} not found`);
  }

  entry.name = trimmedName;
  fs.writeFileSync(fullPath, `${JSON.stringify(raw, null, 2)}\n`);

  const updated = loadServerInventory(fullPath).find((server) => server.id === serverId);
  if (!updated) {
    throw new Error(`Server ${serverId} not found`);
  }
  return updated;
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric environment value, received ${value}`);
  }
  return parsed;
}

function defaultAlertSettings(): AlertSettings {
  return {
    enabled: false,
    wechatRoomId: "",
    wechatRecipients: [],
    wechatAccounts: [],
    cooldownMinutes: 60,
    language: "en",
    sshCommandTimeoutSeconds: DEFAULT_SSH_COMMAND_TIMEOUT_SECONDS,
    sshConnectTimeoutSeconds: DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS
  };
}

function normalizeAlertSettings(value: Record<string, unknown>): AlertSettings {
  const enabled = value.enabled == null ? false : requiredBoolean(value.enabled, "alerts.enabled");
  const cooldownMinutes = value.cooldownMinutes == null
    ? 60
    : requiredPositiveNumber(value.cooldownMinutes, "alerts.cooldownMinutes");
  const language = value.language == null ? "en" : requiredAlertLanguage(value.language);
  const sshCommandTimeoutSeconds = value.sshCommandTimeoutSeconds == null
    ? DEFAULT_SSH_COMMAND_TIMEOUT_SECONDS
    : requiredPositiveNumber(value.sshCommandTimeoutSeconds, "alerts.sshCommandTimeoutSeconds");
  const sshConnectTimeoutSeconds = value.sshConnectTimeoutSeconds == null
    ? DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS
    : requiredPositiveNumber(value.sshConnectTimeoutSeconds, "alerts.sshConnectTimeoutSeconds");

  // Normalize recipients array
  let recipients: WeChatRecipient[] = [];
  if (Array.isArray(value.wechatRecipients)) {
    const seenContactIds = new Set<string>();
    recipients = value.wechatRecipients
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => {
        const contactId = typeof r.contactId === "string" ? r.contactId.trim() : "";
        const label = typeof r.label === "string" ? r.label.trim() : "";
        return {
          id: typeof r.id === "string" ? r.id : randomUUID(),
          contactId,
          label: label || contactId,
          enabled: typeof r.enabled === "boolean" ? r.enabled : true,
          addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date().toISOString()
        };
      })
      .filter((r) => {
        if (r.contactId === "" || seenContactIds.has(r.contactId)) return false;
        seenContactIds.add(r.contactId);
        return true;
      });
  }

  // Legacy migration: if no recipients but wechatRoomId is set, create one
  const legacyRoomId = value.wechatRoomId == null ? "" : optionalString(value.wechatRoomId, "alerts.wechatRoomId").trim();
  if (recipients.length === 0 && legacyRoomId !== "") {
    recipients.push({
      id: randomUUID(),
      contactId: legacyRoomId,
      label: legacyRoomId,
      enabled: true,
      addedAt: new Date().toISOString()
    });
  }

  // Derive wechatRoomId from first enabled recipient
  const firstEnabled = recipients.find((r) => r.enabled);
  const wechatRoomId = firstEnabled?.contactId ?? "";
  const accounts = normalizeWeChatAccounts(value.wechatAccounts);

  return {
    enabled,
    wechatRoomId,
    wechatRecipients: recipients,
    wechatAccounts: accounts,
    cooldownMinutes,
    language,
    sshCommandTimeoutSeconds,
    sshConnectTimeoutSeconds
  };
}

function normalizeWeChatAccounts(value: unknown): WeChatAccount[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID();
      const label = typeof item.label === "string" ? item.label.trim() : "";
      const botUserId = typeof item.botUserId === "string" && item.botUserId.trim()
        ? item.botUserId.trim()
        : null;
      const alertTargetUserId = typeof item.alertTargetUserId === "string" && item.alertTargetUserId.trim()
        ? item.alertTargetUserId.trim()
        : null;
      return {
        id,
        label: label || botUserId || alertTargetUserId || id,
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
        addedAt: typeof item.addedAt === "string" ? item.addedAt : new Date().toISOString(),
        botUserId,
        alertTargetUserId
      };
    })
    .filter((account) => {
      if (seenIds.has(account.id)) return false;
      seenIds.add(account.id);
      return true;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function requiredPositiveNumber(value: unknown, name: string): number {
  const parsed = requiredNumber(value, name);
  if (parsed <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
  return parsed;
}

function requiredAlertLanguage(value: unknown): AlertSettings["language"] {
  if (value !== "en" && value !== "zh") {
    throw new Error("alerts.language must be en or zh");
  }
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}
