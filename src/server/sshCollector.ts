import { Client } from "ssh2";
import type { MetricSnapshot, ServerConfig } from "../shared/types";
import { buildFailureSnapshot, buildMetricSnapshot, parseCollectorOutput } from "./metrics";

export type SshCredentials = {
  username: string;
  password: string;
};

export type SshExecutor = {
  run(server: ServerConfig, credentials: SshCredentials, command: string): Promise<string>;
};

export const COLLECTOR_COMMAND = String.raw`set -e
read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat
total1=$((user + nice + system + idle + iowait + irq + softirq + steal))
idle1=$((idle + iowait))
sleep 1
read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat
total2=$((user + nice + system + idle + iowait + irq + softirq + steal))
idle2=$((idle + iowait))
cpu_used=$(awk -v t1="$total1" -v t2="$total2" -v i1="$idle1" -v i2="$idle2" 'BEGIN { total=t2-t1; idle=i2-i1; if (total <= 0) print 0; else printf "%.2f", (total-idle)*100/total }')
cpu_model=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^[ \t]*//')
cpu_vcores=$(nproc)

mem_vals=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print t, a}' /proc/meminfo)
mem_total=$(echo $mem_vals | awk '{print $1}')
mem_available=$(echo $mem_vals | awk '{print $2}')
mem_used=$((mem_total - mem_available))
mem_used_percent=$(awk -v t="$mem_total" -v a="$mem_available" 'BEGIN { if (t <= 0) print 0; else printf "%.2f", (t-a)*100/t }')

disk_vals=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $2, $3, $5}')
disk_total=$(echo $disk_vals | awk '{print $1}')
disk_used=$(echo $disk_vals | awk '{print $2}')
disk_percent=$(echo $disk_vals | awk '{print $3}')

mem_total_bytes=$(awk -v t="$mem_total" 'BEGIN { printf "%.0f", t * 1024 }')
mem_used_bytes=$(awk -v u="$mem_used" 'BEGIN { printf "%.0f", u * 1024 }')
disk_total_bytes=$(awk -v t="$disk_total" 'BEGIN { printf "%.0f", t * 1024 }')
disk_used_bytes=$(awk -v u="$disk_used" 'BEGIN { printf "%.0f", u * 1024 }')

read load1 load5 load15 rest < /proc/loadavg
uptime_seconds=$(awk '{ printf "%d", $1 }' /proc/uptime)

echo "CPU_USED_PERCENT=$cpu_used"
echo "CPU_MODEL=$cpu_model"
echo "CPU_VCORES=$cpu_vcores"
echo "MEMORY_USED_PERCENT=$mem_used_percent"
echo "MEMORY_TOTAL_BYTES=$mem_total_bytes"
echo "MEMORY_USED_BYTES=$mem_used_bytes"
echo "DISK_USED_PERCENT=$disk_percent"
echo "DISK_TOTAL_BYTES=$disk_total_bytes"
echo "DISK_USED_BYTES=$disk_used_bytes"
echo "LOAD_1=$load1"
echo "LOAD_5=$load5"
echo "LOAD_15=$load15"
echo "UPTIME_SECONDS=$uptime_seconds"`;

export async function collectServerMetrics(
  server: ServerConfig,
  credentials: SshCredentials,
  executor: SshExecutor = new Ssh2Executor()
): Promise<MetricSnapshot> {
  try {
    const output = await executor.run(server, credentials, COLLECTOR_COMMAND);
    const metrics = parseCollectorOutput(output);
    return buildMetricSnapshot(server.id, metrics);
  } catch (error) {
    const normalized = normalizeCollectorError(error);
    return buildFailureSnapshot(server.id, normalized.code, normalized.message);
  }
}

class Ssh2Executor implements SshExecutor {
  run(server: ServerConfig, credentials: SshCredentials, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const timeout = setTimeout(() => {
        settle(new Error("SSH command timed out"), true);
      }, 15_000);

      const settle = (value: Error | string, failed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.end();
        if (failed) reject(value);
        else resolve(String(value));
      };

      client
        .on("ready", () => {
          client.exec(command, (execError, stream) => {
            if (execError) {
              settle(execError, true);
              return;
            }

            let stdout = "";
            let stderr = "";
            stream
              .on("close", (code: number | null) => {
                if (code && code !== 0) {
                  settle(new Error(stderr || `SSH command exited with code ${code}`), true);
                } else {
                  settle(stdout, false);
                }
              })
              .on("data", (chunk: Buffer) => {
                stdout += chunk.toString("utf8");
              });

            stream.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
          });
        })
        .on("error", (error) => settle(error, true))
        .connect({
          host: server.host,
          port: server.port,
          username: credentials.username,
          password: credentials.password,
          readyTimeout: 10_000
        });
    });
  }
}

function normalizeCollectorError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";

  if (code === "AUTH_FAILED" || /auth/i.test(message)) {
    return { code: "auth_failed", message };
  }
  if (/missing metric/i.test(message)) {
    return { code: "parse_failed", message };
  }
  if (/timed out|timeout/i.test(message)) {
    return { code: "timeout", message };
  }
  return { code: "connect_failed", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
