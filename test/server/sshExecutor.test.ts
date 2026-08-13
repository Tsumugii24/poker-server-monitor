import { EventEmitter } from "node:events";
import type { Client, ConnectConfig } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ssh2Executor } from "../../src/server/sshCollector";
import type { ServerConfig } from "../../src/shared/types";

const server: ServerConfig = {
  id: "solver-01",
  name: "Solver 01",
  host: "10.0.0.1",
  port: 22,
  enabled: true,
  note: "TBD"
};

class FakeSshClient extends EventEmitter {
  connectOptions: ConnectConfig | null = null;
  readonly end = vi.fn();
  readonly exec = vi.fn();

  connect(options: ConnectConfig): this {
    this.connectOptions = options;
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Ssh2Executor", () => {
  it("starts the command timeout only after the SSH handshake is ready", async () => {
    vi.useFakeTimers();
    const client = new FakeSshClient();
    const executor = new Ssh2Executor(
      () => ({ connectTimeoutMs: 1_234, commandTimeoutMs: 50 }),
      () => client as unknown as Client
    );

    const pending = executor.run(server, { username: "root", password: "secret" }, "true");
    const rejected = expect(pending).rejects.toThrow("SSH command timed out");

    expect(client.connectOptions?.readyTimeout).toBe(1_234);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.end).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();

    client.emit("ready");
    expect(client.exec).toHaveBeenCalledWith("true", expect.any(Function));
    await vi.advanceTimersByTimeAsync(51);

    await rejected;
    expect(client.end).toHaveBeenCalledOnce();
  });
});
