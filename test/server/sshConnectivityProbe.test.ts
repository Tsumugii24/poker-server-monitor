import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeSshConnectivity } from "../../src/server/sshConnectivityProbe";

const openServers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("probeSshConnectivity", () => {
  it("reports TCP plus SSH banner connectivity without authenticating", async () => {
    const server = await listen((socket) => socket.write("SSH-2.0-OpenSSH_9.6\r\n"));

    const result = await probeSshConnectivity({ host: "127.0.0.1", port: portOf(server) });

    expect(result).toMatchObject({
      reachable: true,
      banner: "SSH-2.0-OpenSSH_9.6",
      errorCode: null,
      errorMessage: null
    });
    expect(result.latencyMs).toBeTypeOf("number");
  });

  it("treats a connected port that closes without a banner as reachable", async () => {
    const server = await listen((socket) => socket.end());

    const result = await probeSshConnectivity({ host: "127.0.0.1", port: portOf(server) });

    expect(result).toMatchObject({
      reachable: true,
      banner: "Port open (no banner)"
    });
  });
});

async function listen(onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer(onConnection);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return address.port;
}
