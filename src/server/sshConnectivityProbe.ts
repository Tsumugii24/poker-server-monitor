import net from "node:net";
import type { ServerConfig } from "../shared/types";

export const DEFAULT_CONNECTIVITY_CONNECT_TIMEOUT_MS = 8_000;
export const DEFAULT_CONNECTIVITY_BANNER_TIMEOUT_MS = 4_000;

export type SshConnectivityProbeResult = {
  reachable: boolean;
  latencyMs: number | null;
  banner: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type SshConnectivityProbeOptions = {
  connectTimeoutMs?: number;
  bannerTimeoutMs?: number;
};

/**
 * Provider-compatible connectivity probe: open the TCP port, then wait for the
 * SSH banner. It deliberately does not authenticate or execute a command.
 */
export function probeSshConnectivity(
  server: Pick<ServerConfig, "host" | "port">,
  options: SshConnectivityProbeOptions = {}
): Promise<SshConnectivityProbeResult> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECTIVITY_CONNECT_TIMEOUT_MS;
  const bannerTimeoutMs = options.bannerTimeoutMs ?? DEFAULT_CONNECTIVITY_BANNER_TIMEOUT_MS;

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host: server.host, port: server.port });
    let connected = false;
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let bannerTimer: NodeJS.Timeout | null = null;

    const finish = (result: SshConnectivityProbeResult): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (bannerTimer) clearTimeout(bannerTimer);
      socket.destroy();
      resolve(result);
    };

    connectTimer = setTimeout(() => {
      finish(failure("connect_timeout", "Connection timed out"));
    }, connectTimeoutMs);

    socket.once("connect", () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      bannerTimer = setTimeout(() => {
        finish(failure("banner_timeout", "SSH banner timed out"));
      }, bannerTimeoutMs);
    });

    socket.once("data", (chunk) => {
      const banner = chunk.toString("utf8").trim();
      finish({
        reachable: true,
        latencyMs: roundLatency(performance.now() - startedAt),
        banner: banner || "Port open (no banner)",
        errorCode: null,
        errorMessage: null
      });
    });

    socket.once("end", () => {
      if (!connected) return;
      finish({
        reachable: true,
        latencyMs: roundLatency(performance.now() - startedAt),
        banner: "Port open (no banner)",
        errorCode: null,
        errorMessage: null
      });
    });

    socket.once("error", (error: NodeJS.ErrnoException) => {
      const refused = error.code === "ECONNREFUSED";
      finish(failure(
        refused ? "connection_refused" : "connect_failed",
        refused ? "Connection refused (port may be closed)" : error.message
      ));
    });
  });
}

function failure(errorCode: string, errorMessage: string): SshConnectivityProbeResult {
  return {
    reachable: false,
    latencyMs: null,
    banner: null,
    errorCode,
    errorMessage
  };
}

function roundLatency(value: number): number {
  return Math.round(value * 100) / 100;
}
