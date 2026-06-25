import type { AlertSettings } from "./types";

export const DEFAULT_SSH_COMMAND_TIMEOUT_SECONDS = 15;
export const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 10;

export type SshTimeoutOptions = {
  commandTimeoutMs: number;
  connectTimeoutMs: number;
};

export function resolveSshTimeouts(
  settings: Pick<AlertSettings, "sshCommandTimeoutSeconds" | "sshConnectTimeoutSeconds">
): SshTimeoutOptions {
  return {
    commandTimeoutMs: Math.max(1, settings.sshCommandTimeoutSeconds) * 1000,
    connectTimeoutMs: Math.max(1, settings.sshConnectTimeoutSeconds) * 1000
  };
}
