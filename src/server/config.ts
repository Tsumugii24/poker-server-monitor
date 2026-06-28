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
  preflopRangesPath: string;
  pipelineStatusFilePath: string;
  solverJobRepoNamespace: string;
  ssh: {
    username: string;
    password: string;
  };
};

type EnvSource = Record<string, string | undefined>;

export type ServerInventoryCreateInput = {
  host: string;
  port?: number;
  group?: string | null;
  enabled?: boolean;
  note?: string;
  solverRoot?: string | null;
  tmuxSession?: string | null;
  pipelineStatusFilePath?: string | null;
};

export type ServerInventoryUpdateInput = {
  host?: string;
  port?: number;
  group?: string | null;
  enabled?: boolean;
  note?: string;
  solverRoot?: string | null;
  tmuxSession?: string | null;
  pipelineStatusFilePath?: string | null;
};

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
    preflopRangesPath: env.SERVER_MONITOR_PREFLOP_RANGES_PATH ?? "config/preflop-ranges",
    pipelineStatusFilePath: env.PIPELINE_STATUS_FILE ?? "~/run/solver_running_status.json",
    solverJobRepoNamespace: env.HF_DEFAULT_NAMESPACE ?? "Tsumugii",
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
      port: item.port == null ? 22 : requiredPort(item.port, `servers[${index}].port`),
      enabled: item.enabled == null ? true : requiredBoolean(item.enabled, `servers[${index}].enabled`),
      note: item.note == null ? "TBD" : requiredString(item.note, `servers[${index}].note`)
    };

    if (item.group != null) {
      server.group = requiredString(item.group, `servers[${index}].group`);
    }
    if (item.solverRoot != null) {
      server.solverRoot = requiredTrimmedString(item.solverRoot, `servers[${index}].solverRoot`);
    }
    if (item.tmuxSession != null) {
      server.tmuxSession = requiredTrimmedString(item.tmuxSession, `servers[${index}].tmuxSession`);
    }
    if (item.pipelineStatusFilePath != null) {
      server.pipelineStatusFilePath = requiredTrimmedString(
        item.pipelineStatusFilePath,
        `servers[${index}].pipelineStatusFilePath`
      );
    }

    return server;
  });
}

export function createServerInventoryEntry(
  filename: string,
  input: ServerInventoryCreateInput
): ServerConfig {
  const host = requiredTrimmedString(input.host, "host");
  const port = input.port == null ? 22 : requiredPort(input.port, "port");
  const note = input.note == null ? "TBD" : requiredInventoryNote(input.note);
  const group = input.group == null ? null : optionalTrimmedString(input.group, "group");
  const enabled = input.enabled == null ? true : requiredBoolean(input.enabled, "enabled");
  const solverRoot = input.solverRoot == null ? null : optionalTrimmedString(input.solverRoot, "solverRoot");
  const tmuxSession = input.tmuxSession == null ? null : optionalTrimmedString(input.tmuxSession, "tmuxSession");
  const pipelineStatusFilePath = input.pipelineStatusFilePath == null
    ? null
    : optionalTrimmedString(input.pipelineStatusFilePath, "pipelineStatusFilePath");

  const { fullPath, raw } = readServerInventoryRaw(filename);
  const entry: Record<string, unknown> = {
    id: generateServerId(raw, host, port),
    name: host,
    host,
    port,
    enabled,
    note
  };
  if (group) {
    entry.group = group;
  }
  if (solverRoot) {
    entry.solverRoot = solverRoot;
  }
  if (tmuxSession) {
    entry.tmuxSession = tmuxSession;
  }
  if (pipelineStatusFilePath) {
    entry.pipelineStatusFilePath = pipelineStatusFilePath;
  }

  raw.push(entry);
  writeServerInventoryRaw(fullPath, raw);

  const created = loadServerInventory(fullPath).find((server) => server.id === entry.id);
  if (!created) {
    throw new Error(`Server ${entry.id} not found`);
  }
  return created;
}

export function updateServerInventoryEntry(
  filename: string,
  serverId: string,
  patch: ServerInventoryUpdateInput
): ServerConfig {
  const { fullPath, raw } = readServerInventoryRaw(filename);
  const entry = findRawServerEntry(raw, serverId);

  if (patch.host !== undefined) {
    entry.host = requiredTrimmedString(patch.host, "host");
  }
  if (patch.port !== undefined) {
    entry.port = requiredPort(patch.port, "port");
  }
  if (patch.group !== undefined) {
    const group = patch.group == null ? null : optionalTrimmedString(patch.group, "group");
    if (group) {
      entry.group = group;
    } else {
      delete entry.group;
    }
  }
  if (patch.enabled !== undefined) {
    entry.enabled = requiredBoolean(patch.enabled, "enabled");
  }
  if (patch.note !== undefined) {
    entry.note = requiredInventoryNote(patch.note);
  }
  if (patch.solverRoot !== undefined) {
    const solverRoot = patch.solverRoot == null ? null : optionalTrimmedString(patch.solverRoot, "solverRoot");
    if (solverRoot) {
      entry.solverRoot = solverRoot;
    } else {
      delete entry.solverRoot;
    }
  }
  if (patch.tmuxSession !== undefined) {
    const tmuxSession = patch.tmuxSession == null ? null : optionalTrimmedString(patch.tmuxSession, "tmuxSession");
    if (tmuxSession) {
      entry.tmuxSession = tmuxSession;
    } else {
      delete entry.tmuxSession;
    }
  }
  if (patch.pipelineStatusFilePath !== undefined) {
    const pipelineStatusFilePath = patch.pipelineStatusFilePath == null
      ? null
      : optionalTrimmedString(patch.pipelineStatusFilePath, "pipelineStatusFilePath");
    if (pipelineStatusFilePath) {
      entry.pipelineStatusFilePath = pipelineStatusFilePath;
    } else {
      delete entry.pipelineStatusFilePath;
    }
  }

  writeServerInventoryRaw(fullPath, raw);

  const updated = loadServerInventory(fullPath).find((server) => server.id === serverId);
  if (!updated) {
    throw new Error(`Server ${serverId} not found`);
  }
  return updated;
}

export function deleteServerInventoryEntry(filename: string, serverId: string): ServerConfig[] {
  const { fullPath, raw } = readServerInventoryRaw(filename);
  const index = raw.findIndex((item) => isRecord(item) && item.id === serverId);
  if (index === -1) {
    throw new Error(`Server ${serverId} not found`);
  }

  raw.splice(index, 1);
  writeServerInventoryRaw(fullPath, raw);
  return loadServerInventory(fullPath);
}

export function updateServerInventoryNote(
  filename: string,
  serverId: string,
  note: string
): ServerConfig {
  return updateServerInventoryEntry(filename, serverId, { note });
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

  const { fullPath, raw } = readServerInventoryRaw(filename);
  const entry = findRawServerEntry(raw, serverId);

  if (entry.name === trimmedName) {
    const current = loadServerInventory(fullPath).find((server) => server.id === serverId);
    if (!current) {
      throw new Error(`Server ${serverId} not found`);
    }
    return current;
  }
  entry.name = trimmedName;
  writeServerInventoryRaw(fullPath, raw);

  const updated = loadServerInventory(fullPath).find((server) => server.id === serverId);
  if (!updated) {
    throw new Error(`Server ${serverId} not found`);
  }
  return updated;
}

function readServerInventoryRaw(filename: string): { fullPath: string; raw: unknown[] } {
  const fullPath = path.resolve(filename);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Server inventory must be an array: ${filename}`);
  }
  return { fullPath, raw };
}

function writeServerInventoryRaw(fullPath: string, raw: unknown[]): void {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(raw, null, 2)}\n`);
}

function findRawServerEntry(raw: unknown[], serverId: string): Record<string, unknown> {
  const entry = raw.find((item) => isRecord(item) && item.id === serverId);
  if (!entry || !isRecord(entry)) {
    throw new Error(`Server ${serverId} not found`);
  }
  return entry;
}

function generateServerId(raw: unknown[], host: string, port: number): string {
  const existing = new Set(
    raw.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : [])
  );
  const hostId = host.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `${hostId || "server"}${port === 22 ? "" : `-${port}`}`;
  let id = base;
  let suffix = 2;
  while (existing.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function requiredInventoryNote(value: unknown): string {
  const note = requiredTrimmedString(value, "note");
  if (note === "") {
    throw new Error("note must be a non-empty string");
  }
  return note;
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
  const seenContacts = new Set<string>();
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
      const contactKeys = [account.botUserId, account.alertTargetUserId].filter((id): id is string => Boolean(id));
      if (contactKeys.some((id) => seenContacts.has(id))) return false;
      for (const id of contactKeys) {
        seenContacts.add(id);
      }
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

function requiredTrimmedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalTrimmedString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value.trim();
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

function requiredPort(value: unknown, name: string): number {
  const port = requiredNumber(value, name);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
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
