import type {
  ConnectionStatus,
  MetricSnapshot,
  PipelineStatusSnapshot,
  ServerRow
} from "./types";

export type ConnectionDisplayStatus = ConnectionStatus | "degraded";

type ServerStatus = Pick<ServerRow, "latest" | "pipeline">;

/** TCP/SSH-banner connectivity is online even when authenticated collection is degraded. */
export function serverHasConnectivity(server: ServerStatus | null | undefined): boolean {
  return server?.latest?.connectionStatus === "online";
}

/** An authenticated metric command completed successfully. */
export function serverIsSshReady(server: ServerStatus | null | undefined): boolean {
  return serverHasConnectivity(server) && server?.latest?.errorCode == null;
}

/** Safe candidate for job/operation SSH work; a known pipeline probe failure blocks dispatch. */
export function serverIsJobReady(server: ServerStatus | null | undefined): boolean {
  return serverIsSshReady(server) && (!server?.pipeline || server.pipeline.errorCode == null);
}

export function connectionDisplayStatus(
  latest: MetricSnapshot | null | undefined,
  pipeline?: PipelineStatusSnapshot | null
): ConnectionDisplayStatus {
  const status = latest?.connectionStatus ?? "unknown";
  if (status === "online" && (latest?.errorCode != null || pipeline?.errorCode != null)) {
    return "degraded";
  }
  return status;
}
