import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig, loadServerInventory, updateServerInventoryName } from "../../src/server/config";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-config-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("server inventory loading", () => {
  it("loads inventory with default port and enabled values", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ id: "prod-01", name: "Production 01", host: "10.0.0.1" }])
    );

    expect(loadServerInventory(file)).toEqual([
      {
        id: "prod-01",
        name: "Production 01",
        host: "10.0.0.1",
        port: 22,
        enabled: true
      }
    ]);
  });

  it("rejects duplicate server ids", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "prod-01", name: "Production 01", host: "10.0.0.1" },
        { id: "prod-01", name: "Production 01 Copy", host: "10.0.0.2" }
      ])
    );

    expect(() => loadServerInventory(file)).toThrow("Duplicate server id prod-01");
  });

  it("updates a server name in the inventory file", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
        { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 2222, enabled: false }
      ])
    );

    const updated = updateServerInventoryName(file, "prod-02", "Analytics 02");

    expect(updated).toMatchObject({ id: "prod-02", name: "Analytics 02", host: "10.0.0.2" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
      { id: "prod-02", name: "Analytics 02", host: "10.0.0.2", port: 2222, enabled: false }
    ]);
  });

  it("rejects empty server names when updating inventory", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "prod-01", name: "Production 01", host: "10.0.0.1" }]));

    expect(() => updateServerInventoryName(file, "prod-01", "   ")).toThrow("name must be a non-empty string");
  });
});

describe("runtime config loading", () => {
  it("loads SSH credentials and runtime defaults from environment", () => {
    const config = loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret"
    });

    expect(config.ssh.username).toBe("root");
    expect(config.ssh.password).toBe("secret");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
    expect(config.refreshIntervalMs).toBe(3_600_000);
  });

  it("allows overriding the HTTP bind host for deployment", () => {
    const config = loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret",
      SERVER_MONITOR_HOST: "0.0.0.0"
    });

    expect(config.host).toBe("0.0.0.0");
  });

  it("fails clearly when SSH credentials are missing", () => {
    expect(() => loadRuntimeConfig({ SSH_USERNAME: "root" })).toThrow(
      "SSH_PASSWORD is required"
    );
  });
});
