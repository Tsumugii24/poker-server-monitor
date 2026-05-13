import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { ServerConfig } from "../shared/types";

export type RuntimeConfig = {
  host: string;
  port: number;
  databasePath: string;
  refreshIntervalMs: number;
  inventoryPath: string;
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
    ssh: {
      username,
      password
    }
  };
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
      enabled: item.enabled == null ? true : requiredBoolean(item.enabled, `servers[${index}].enabled`)
    };

    if (item.group != null) {
      server.group = requiredString(item.group, `servers[${index}].group`);
    }

    return server;
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}
