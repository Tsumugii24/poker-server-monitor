import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOLVER_JOB_SETTINGS } from "../../src/shared/solverJobs";
import type { ConnectionStatus, MetricSnapshot, PipelineStatusSnapshot, ServerConfig } from "../../src/shared/types";
import { createApp } from "../../src/server/api";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";
import {
  buildForceKillPipelineCommand,
  buildGracefulStopPipelineCommand,
  buildRunPipelineCommand,
  datasetNameFromRangePath,
  scenarioFromRangePath,
  solverRangeTextFromDocument,
  SolverJobService
} from "../../src/server/solverJobService";
import type { SshExecutor } from "../../src/server/sshCollector";

describe("solver job helpers", () => {
  it("derives canonical dataset names and scenarios from range paths", () => {
    const threeBetPath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
    expect(scenarioFromRangePath(threeBetPath)).toBe("3ia-3od");
    expect(datasetNameFromRangePath(threeBetPath, "3ia-3od")).toBe("3ia-4.2-3od-4.3");

    const openPath = "SOD/2.5bb/SIA-45 vs SOD-40.json";
    expect(scenarioFromRangePath(openPath)).toBe("sia-sod-open2.5");
    expect(datasetNameFromRangePath(openPath, "sia-sod-open2.5")).toBe("sia-45-sod-40");
  });

  it("converts reviewed range JSON into solver range text", () => {
    const text = solverRangeTextFromDocument({
      player_names: { A: "3OD-4.3", B: "3IA-4.2" },
      player_positions: { A: "OOP", B: "IP" },
      learned: true,
      A: { raise: "AA", call: "AKs:0.250" },
      B: { raise: "KK:0.500", call: "KQs" }
    });

    expect(text).toContain('OOP_RANGE = "AA,AKs:0.250"');
    expect(text).toContain('IP_RANGE = "KK:0.500,KQs"');
  });

  it("builds a run_pipeline command with repo id and solver settings", () => {
    const command = buildRunPipelineCommand({
      solverRoot: "/srv/solver",
      repoId: "Tsumugii/3ia-4.2-3od-4.3",
      scenario: "3ia-3od",
      rangePath: "~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt",
      statusFilePath: "~/run/status.json",
      settings: {
        ...DEFAULT_SOLVER_JOB_SETTINGS,
        uploadEnabled: false,
        estimateMemory: true,
        stallTimeoutSeconds: 60
      }
    });

    expect(command).toContain("cd '/srv/solver'");
    expect(command).toContain("'--no-upload'");
    expect(command).toContain("'--scenario' '3ia-3od'");
    expect(command).toContain("'--range-path' '~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt'");
    expect(command).not.toContain("'--range-file'");
    expect(command).not.toContain("'--repo-id'");
    expect(command).not.toContain("'--upload-format'");
    expect(command).not.toContain("'--upload-attempt-timeout'");
    expect(command).not.toContain("http_proxy");
    expect(command).not.toContain("https_proxy");
    expect(command).not.toContain("HF_TOKEN");
    expect(command).not.toContain("'--estimate-memory'");
    expect(command).toContain("'--stall-timeout' '60'");
    expect(command).toContain("PIPELINE_STATUS_FILE='~/run/status.json'");
  });

  it("adds proxy and HF token exports when upload is enabled", () => {
    const command = buildRunPipelineCommand({
      solverRoot: "/srv/solver",
      repoId: "Tsumugii/3ia-4.2-3od-4.3",
      scenario: "3ia-3od",
      rangePath: "~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt",
      statusFilePath: "~/run/status.json",
      settings: DEFAULT_SOLVER_JOB_SETTINGS,
      hfToken: "hf_test_token"
    });

    expect(command).toContain("export http_proxy='http://127.0.0.1:7890'");
    expect(command).toContain("export https_proxy='http://127.0.0.1:7890'");
    expect(command).toContain("export HF_TOKEN='hf_test_token'");
    expect(command).toContain("'--repo-id' 'Tsumugii/3ia-4.2-3od-4.3'");
    expect(command).toContain("'--scenario' '3ia-3od'");
    expect(command).toContain("'--range-path' '~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt'");
    expect(command).toContain("'--upload-format' 'parquet'");
    expect(command).not.toContain("'--no-upload'");
  });

  it("can build a run_pipeline command with inline OOP/IP ranges", () => {
    const command = buildRunPipelineCommand({
      solverRoot: "/srv/solver",
      repoId: "Tsumugii/manual-range",
      scenario: "sia-sod",
      oopRange: "AA,AKs:0.500",
      ipRange: "KK,AQs:0.250",
      statusFilePath: "~/run/status.json",
      settings: {
        ...DEFAULT_SOLVER_JOB_SETTINGS,
        uploadEnabled: false
      }
    });

    expect(command).toContain("'--scenario' 'sia-sod'");
    expect(command).toContain("'--oop-range' 'AA,AKs:0.500'");
    expect(command).toContain("'--ip-range' 'KK,AQs:0.250'");
    expect(command).not.toContain("'--range-path'");
    expect(command).not.toContain("'--range-file'");
  });

  it("redacts HF token in display commands", () => {
    const command = buildRunPipelineCommand({
      solverRoot: "/srv/solver",
      repoId: "Tsumugii/3ia-4.2-3od-4.3",
      scenario: "3ia-3od",
      rangePath: "~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt",
      statusFilePath: "~/run/status.json",
      settings: DEFAULT_SOLVER_JOB_SETTINGS,
      hfToken: "hf_test_token",
      redactSecrets: true
    });

    expect(command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(command).not.toContain("hf_test_token");
  });

  it("requires HF_TOKEN when upload is enabled", () => {
    expect(() => buildRunPipelineCommand({
      solverRoot: "/srv/solver",
      repoId: "Tsumugii/3ia-4.2-3od-4.3",
      scenario: "3ia-3od",
      rangePath: "~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt",
      statusFilePath: "~/run/status.json",
      settings: DEFAULT_SOLVER_JOB_SETTINGS
    })).toThrow("HF_TOKEN is required");
  });

  it("builds separate graceful and force stop commands", () => {
    const job = {
      tmuxSession: "solver",
      command: "cd '/srv/solver' && python run_pipeline.py all --status-file '~/run/status.json'"
    } as Parameters<typeof buildGracefulStopPipelineCommand>[0];
    const graceful = buildGracefulStopPipelineCommand(job);
    const force = buildForceKillPipelineCommand(job);

    expect(graceful).toContain("tmux send-keys -t \"$SESSION\" C-c");
    expect(graceful).toContain("PIPELINE_ALIVE=1");
    expect(graceful).not.toContain("tmux kill-session");
    expect(force).toContain("tmux kill-session -t \"$SESSION\"");
    expect(force).toContain("kill -TERM");
    expect(force).toContain("kill -KILL");
  });
});

describe("solver job API", () => {
  let tempDir: string;
  let preflopRangesPath: string;
  let db: MonitorDatabase;
  let refreshService: RefreshService;
  let commands: string[];

  const servers: ServerConfig[] = [
    {
      id: "solver-01",
      name: "Solver 01",
      host: "10.0.0.1",
      port: 22,
      enabled: true,
      note: "TBD",
      solverRoot: "/srv/solver",
      tmuxSession: "solver",
      pipelineStatusFilePath: "~/run/status.json"
    }
  ];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-jobs-"));
    preflopRangesPath = path.join(tempDir, "preflop-ranges");
    fs.mkdirSync(path.join(preflopRangesPath, "3OD-EP"), { recursive: true });
    fs.mkdirSync(path.join(preflopRangesPath, "SOD", "2.5bb"), { recursive: true });
    fs.writeFileSync(
      path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json"),
      JSON.stringify({
        player_names: { A: "3OD-4.3", B: "3IA-4.2" },
        player_positions: { A: "OOP", B: "IP" },
        learned: false,
        A: { raise: "AA", call: "AKs:0.250" },
        B: { raise: "KK:0.500", call: "KQs" }
      })
    );
    fs.writeFileSync(
      path.join(preflopRangesPath, "SOD", "2.5bb", "SIA-45 vs SOD-40.json"),
      JSON.stringify({
        player_names: { A: "SOD-40", B: "SIA-45" },
        player_positions: { A: "OOP", B: "IP" },
        learned: true,
        A: { raise: "AA", call: "AKs:0.250" },
        B: { raise: "KK:0.500", call: "KQs" }
      })
    );

    db = await MonitorDatabase.createInMemory();
    db.syncServers(servers);
    db.insertSnapshot(metricSnapshot("solver-01", "online"));
    refreshService = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async () => {
        throw new Error("not used");
      }
    });
    commands = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("previews, confirms, creates, and starts a solver job", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        return "ok";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";

    const preview = await request(app)
      .post("/api/jobs/preview")
      .send({ serverId: "solver-01", rangePath });

    expect(preview.status).toBe(200);
    expect(preview.body.repoId).toBe("Tsumugii/3ia-4.2-3od-4.3");
    expect(preview.body.scenario).toBe("3ia-3od");
    expect(preview.body.remoteRangePath).toBe("~/solver/job-ranges/<job-id>/3ia-4.2-3od-4.3.txt");
    expect(preview.body.requiresConfirmation).toBe(true);
    expect(preview.body.commandPreview).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(preview.body.commandPreview).not.toContain("hf_test_token");
    expect(preview.body.commandPreview).toContain("export http_proxy='http://127.0.0.1:7890'");
    expect(preview.body.commandPreview).toContain("'--scenario' '3ia-3od'");
    expect(preview.body.commandPreview).toContain("'--range-path' '~/solver/job-ranges/<job-id>/3ia-4.2-3od-4.3.txt'");

    const noUploadPreview = await request(app)
      .post("/api/jobs/preview")
      .send({ serverId: "solver-01", rangePath, settings: { uploadEnabled: false, estimateMemory: true } });

    expect(noUploadPreview.status).toBe(200);
    expect(noUploadPreview.body.settings.uploadEnabled).toBe(false);
    expect(noUploadPreview.body.settings.estimateMemory).toBe(false);
    expect(noUploadPreview.body.commandPreview).toContain("'--no-upload'");
    expect(noUploadPreview.body.commandPreview).toContain("'--scenario' '3ia-3od'");
    expect(noUploadPreview.body.commandPreview).toContain("'--range-path' '~/solver/job-ranges/<job-id>/3ia-4.2-3od-4.3.txt'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--repo-id'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--upload-format'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--upload-attempt-timeout'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--estimate-memory'");

    const rejected = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath });

    expect(rejected.status).toBe(409);
    expect(rejected.body.message).toContain("confirmation is required");

    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath, confirmUnstudied: true });

    expect(created.status).toBe(201);
    expect(created.body.job.status).toBe("queued");
    expect(created.body.job.command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(created.body.job.command).not.toContain("hf_test_token");

    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);

    expect(started.status).toBe(200);
    expect(started.body.job.status).toBe("running");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("OOP_RANGE");
    expect(commands[0]).toContain(`RANGE_PATH="$HOME/solver/job-ranges/${created.body.job.id}/3ia-4.2-3od-4.3.txt"`);
    expect(commands[0]).not.toContain(".bak.");
    expect(commands[1]).toContain('-c "$HOME/solver"');
    expect(commands[1]).toContain("tmux send-keys");
    expect(commands[1]).toContain("run_pipeline.py");
    expect(commands[1]).toContain("--scenario");
    expect(commands[1]).toContain("3ia-3od");
    expect(commands[1]).toContain("--range-path");
    expect(commands[1]).toContain(`job-ranges/${created.body.job.id}/3ia-4.2-3od-4.3.txt`);
    expect(commands[1]).toContain("hf_test_token");

    const list = await request(app).get("/api/jobs");
    expect(list.status).toBe(200);
    expect(list.body.jobs[0]).toMatchObject({
      id: created.body.job.id,
      status: "running",
      repoId: "Tsumugii/3ia-4.2-3od-4.3"
    });
    expect(list.body.jobs[0].command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(list.body.jobs[0].command).not.toContain("hf_test_token");
    expect(JSON.stringify(list.body.events)).not.toContain("hf_test_token");
  });

  it("supports graceful stop followed by force stop", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        if (command.includes("C-c")) return "TMUX_SIGNAL_SENT=1\nPIPELINE_ALIVE=1\n";
        return "ok";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath, confirmUnstudied: true });
    await request(app).post(`/api/jobs/${created.body.job.id}/start`);

    const activeDelete = await request(app).post(`/api/jobs/${created.body.job.id}/delete`);

    expect(activeDelete.status).toBe(409);
    expect(activeDelete.body.message).toContain("must be stopped");

    const stopped = await request(app).post(`/api/jobs/${created.body.job.id}/stop`);

    expect(stopped.status).toBe(200);
    expect(stopped.body.job.status).toBe("stopping");
    expect(commands.at(-1)).toContain("tmux send-keys -t \"$SESSION\" C-c");

    const forceStopped = await request(app).post(`/api/jobs/${created.body.job.id}/force-stop`);

    expect(forceStopped.status).toBe(200);
    expect(forceStopped.body.job.status).toBe("interrupted");
    expect(commands.at(-1)).toContain("tmux kill-session -t \"$SESSION\"");
    expect(commands.at(-1)).toContain("kill -KILL");

    const deleted = await request(app).post(`/api/jobs/${created.body.job.id}/delete`);

    expect(deleted.status).toBe(200);
    expect(deleted.body.job.id).toBe(created.body.job.id);

    const list = await request(app).get("/api/jobs");
    expect(list.status).toBe(200);
    expect(list.body.jobs).toHaveLength(0);
    expect(list.body.events).toHaveLength(0);
  });

  it("keeps open-size scenario out of the dataset repo name while passing the scenario explicitly", async () => {
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const preview = await request(app)
      .post("/api/jobs/preview")
      .send({ serverId: "solver-01", rangePath: "SOD/2.5bb/SIA-45 vs SOD-40.json" });

    expect(preview.status).toBe(200);
    expect(preview.body.datasetName).toBe("sia-45-sod-40");
    expect(preview.body.repoId).toBe("Tsumugii/sia-45-sod-40");
    expect(preview.body.scenario).toBe("sia-sod-open2.5");
    expect(preview.body.remoteRangePath).toBe("~/solver/job-ranges/<job-id>/sia-45-sod-40.txt");
    expect(preview.body.commandPreview).toContain("'--repo-id' 'Tsumugii/sia-45-sod-40'");
    expect(preview.body.commandPreview).toContain("'--scenario' 'sia-sod-open2.5'");
    expect(preview.body.commandPreview).toContain("'--range-path' '~/solver/job-ranges/<job-id>/sia-45-sod-40.txt'");

    const overridden = await request(app)
      .post("/api/jobs/preview")
      .send({
        serverId: "solver-01",
        rangePath: "SOD/2.5bb/SIA-45 vs SOD-40.json",
        scenario: "sia-sod-open3"
      });

    expect(overridden.status).toBe(200);
    expect(overridden.body.datasetName).toBe("sia-45-sod-40");
    expect(overridden.body.repoId).toBe("Tsumugii/sia-45-sod-40");
    expect(overridden.body.scenario).toBe("sia-sod-open3");
    expect(overridden.body.remoteRangePath).toBe("~/solver/job-ranges/<job-id>/sia-45-sod-40.txt");
    expect(overridden.body.commandPreview).toContain("'--scenario' 'sia-sod-open3'");
  });

  it("reconciles an active job when server inventory reports the task is idle", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        return "ok";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", confirmUnstudied: true });
    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);
    const collectedAt = new Date(Date.parse(started.body.job.startedAt) + 20_000).toISOString();
    db.insertPipelineSnapshot(idlePipelineSnapshot("solver-01", collectedAt));

    const list = await request(app).get("/api/jobs");

    expect(list.status).toBe(200);
    expect(list.body.jobs[0]).toMatchObject({
      id: created.body.job.id,
      status: "failed"
    });
    expect(list.body.jobs[0].lastError).toContain("Server reports task IDLE");
    expect(list.body.events.some((event: { message: string }) =>
      event.message === "Server task reconciled job as failed."
    )).toBe(true);
  });

  it("rejects job operations while the server is offline", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        return "ok";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", confirmUnstudied: true });
    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);
    db.insertSnapshot(metricSnapshot("solver-01", "offline", new Date(Date.now() + 1000).toISOString()));

    const stopped = await request(app).post(`/api/jobs/${created.body.job.id}/stop`);

    expect(stopped.status).toBe(409);
    expect(stopped.body.message).toContain("offline");
    expect(commands).toHaveLength(2);

    const list = await request(app).get("/api/jobs");
    expect(list.body.jobs[0]).toMatchObject({
      id: started.body.job.id,
      status: "running"
    });
  });
});

function metricSnapshot(
  serverId: string,
  connectionStatus: ConnectionStatus,
  collectedAt = new Date().toISOString()
): MetricSnapshot {
  return {
    id: `${serverId}-${connectionStatus}-${collectedAt}`,
    serverId,
    collectedAt,
    connectionStatus,
    healthLevel: connectionStatus === "online" ? "healthy" : null,
    cpuUsedPercent: connectionStatus === "online" ? 20 : null,
    memoryUsedPercent: connectionStatus === "online" ? 30 : null,
    diskUsedPercent: connectionStatus === "online" ? 40 : null,
    load1: connectionStatus === "online" ? 0.1 : null,
    load5: connectionStatus === "online" ? 0.2 : null,
    load15: connectionStatus === "online" ? 0.3 : null,
    uptimeSeconds: connectionStatus === "online" ? 3600 : null,
    errorCode: connectionStatus === "online" ? null : "offline",
    errorMessage: connectionStatus === "online" ? null : "offline",
    cpuModel: null,
    cpuVcores: null,
    memoryTotalBytes: null,
    memoryUsedBytes: null,
    diskTotalBytes: null,
    diskUsedBytes: null
  };
}

function idlePipelineSnapshot(serverId: string, collectedAt: string): PipelineStatusSnapshot {
  return {
    id: `${serverId}-idle`,
    serverId,
    collectedAt,
    available: false,
    processAlive: null,
    fileStatus: null,
    displayStatus: "idle",
    phase: null,
    repoId: null,
    datasetName: null,
    scenario: null,
    currentBatch: null,
    totalBatches: null,
    totalTasks: null,
    batchExpr: null,
    pid: null,
    startedAt: null,
    updatedAt: collectedAt,
    finishedAt: null,
    command: null,
    error: null,
    errorCode: null,
    errorMessage: null
  };
}
