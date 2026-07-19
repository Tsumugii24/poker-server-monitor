import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOLVER_JOB_SETTINGS, type ParallelFailurePoolEntry } from "../../src/shared/solverJobs";
import type { ServerOperation } from "../../src/shared/serverOperations";
import type { ConnectionStatus, MetricSnapshot, PipelineStatusSnapshot, ServerConfig } from "../../src/shared/types";
import { createApp } from "../../src/server/api";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";
import {
  buildForceKillPipelineCommand,
  buildDispatchPreflightCommand,
  buildDeleteUploadCandidateCommand,
  buildGracefulStopPipelineCommand,
  buildRunPipelineCommand,
  buildReadServerOperationStatusCommand,
  buildServerNetworkCheckCommand,
  buildServerNetworkSyncCommand,
  buildServerSyncCommand,
  buildServerUploadCommand,
  datasetNameFromRangePath,
  parseUploadCandidatesOutput,
  parseDeletedUploadCandidateOutput,
  scenarioFromRangePath,
  solverRangeTextFromDocument,
  SolverJobService
} from "../../src/server/solverJobService";
import { loadSolverScenarioLibrary } from "../../src/server/scenarioLibraryStore";
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
      resultPath: "~/solver/results/3ia-4.2-3od-4.3/job-1",
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
    expect(command).toContain("'--result-path' '~/solver/results/3ia-4.2-3od-4.3/job-1'");
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
      resultPath: "~/solver/results/3ia-4.2-3od-4.3/job-1",
      statusFilePath: "~/run/status.json",
      settings: DEFAULT_SOLVER_JOB_SETTINGS,
      hfToken: "hf_test_token",
      hfProxyUrl: "http://127.0.0.1:7890"
    });

    expect(command).toContain("export http_proxy='http://127.0.0.1:7890'");
    expect(command).toContain("export https_proxy='http://127.0.0.1:7890'");
    expect(command).toContain("export HF_TOKEN='hf_test_token'");
    expect(command).toContain("'--repo-id' 'Tsumugii/3ia-4.2-3od-4.3'");
    expect(command).toContain("'--scenario' '3ia-3od'");
    expect(command).toContain("'--range-path' '~/solver/job-ranges/job-1/3ia-4.2-3od-4.3.txt'");
    expect(command).toContain("'--result-path' '~/solver/results/3ia-4.2-3od-4.3/job-1'");
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

  it("builds server sync commands with proxy and git update steps", () => {
    const command = buildServerSyncCommand({
      solverRoot: "~/solver",
      proxyUrl: "http://127.0.0.1:7890"
    });

    expect(command).toContain('cd "$HOME/solver"');
    expect(command).toContain("export http_proxy='http://127.0.0.1:7890'");
    expect(command).toContain("export https_proxy='http://127.0.0.1:7890'");
    expect(command).toContain("git stash");
    expect(command).toContain("git pull --rebase");
  });

  it("builds a redacted Mihomo repository and config sync command", () => {
    const command = buildServerNetworkSyncCommand({
      giteeUsername: "gitee-login",
      giteeToken: "gitee-secret-token",
      redactSecrets: true
    });

    expect(command).toContain("SUBSCRIPTION_URL=$SUBSCRIPTION_URL");
    expect(command).toContain("GITEE_USERNAME=$GITEE_USERNAME");
    expect(command).toContain("GITEE_TOKEN=$GITEE_TOKEN");
    expect(command).not.toContain("gitee-secret-token");
    expect(command).toContain('REPO_URL="https://gitee.com/Tsumugii24/mihomo-release"');
    expect(command).toContain("export GIT_TERMINAL_PROMPT=0");
    expect(command).toContain('GIT_ASKPASS_FILE=$(mktemp)');
    expect(command).toContain('*Username*) printf');
    expect(command).toContain('*Password*) printf');
    expect(command).toContain('rm -f "$GIT_ASKPASS_FILE"');
    expect(command).toContain("git -c credential.helper= pull");
    expect(command).not.toContain("credential.interactive=never");
    expect(command).toContain('pull --rebase "$REPO_URL" master');
    expect(command).toContain('clone --branch master --single-branch "$REPO_URL"');
    expect(command).toContain('INSTALL_KIND=cached');
    expect(command).toContain('GIT_ATTEMPT_CODE=$GIT_CODE');
    expect(command).toContain("timeout 90 wget --timeout=30 --tries=2");
    expect(command).toContain("config.yaml.previous");
    expect(command).toContain("./mihomo -t -d .");
    expect(command).toContain('tmux new-session -d -s mihomo');
  });

  it("checks Hugging Face through the configured remote proxy", () => {
    const command = buildServerNetworkCheckCommand("http://127.0.0.1:7890");

    expect(command).toContain("tmux has-session -t mihomo");
    expect(command).toContain("--proxy \"$PROXY_URL\" https://huggingface.co/");
    expect(command).toContain("--connect-timeout 10");
    expect(command).toContain('CHECK_KIND=connected');
    expect(command).toContain('CHECK_REASON=tmux_missing');
    expect(command).toContain('CHECK_REASON=proxy_refused');
    expect(command).toContain('CHECK_REASON=timeout');
    expect(command).toContain('"connected": 1 if kind == "connected" else 0');
  });

  it("probes operation status files and tmux liveness together", () => {
    const command = buildReadServerOperationStatusCommand("~/run/operation.json", "sync-server-1");

    expect(command).toContain('STATUS_FILE="$HOME/run/operation.json"');
    expect(command).toContain("tmux has-session");
    expect(command).toContain("OP_STATUS_FILE=1");
    expect(command).toContain("OP_TMUX_ALIVE=1");
    expect(command).toContain('PLAN_FILE="${STATUS_FILE}.upload-plan.json"');
    expect(command).toContain('"progress_inferred": True');
  });

  it("requires the manual Mihomo session and Hugging Face proxy before dispatch", () => {
    const command = buildDispatchPreflightCommand(
      "~/run/solver_running_status.json",
      "http://127.0.0.1:7890"
    );

    expect(command).toContain("tmux has-session -t mihomo");
    expect(command).toContain("--proxy \"$PROXY_URL\" https://huggingface.co/");
    expect(command).toContain("run Sync Network first");
  });

  it("builds server upload commands with results-dir and redacted HF token support", () => {
    const command = buildServerUploadCommand({
      solverRoot: "~/solver",
      hfToken: "hf_upload_token",
      proxyUrl: "http://127.0.0.1:7890",
      redactSecrets: true,
      items: [{
        datasetName: "sia-30-sod-13.5",
        repoId: "Tsumugii/sia-30-sod-13.5",
        jobId: "job-1",
        resultsDir: "~/solver/results/sia-30-sod-13.5/job-1",
        fileFormat: "parquet",
        fileCount: 12
      }]
    });

    expect(command).toContain('cd "$HOME/solver"');
    expect(command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(command).not.toContain("hf_upload_token");
    expect(command).toContain('"resultsDir":"~/solver/results/sia-30-sod-13.5/job-1"');
    expect(command).toContain('"repoId":"Tsumugii/sia-30-sod-13.5"');
    expect(command).toContain('"fileFormat":"parquet"');
    expect(command).toContain('"upload_success"');
    expect(command).toContain('"upload_failed"');
    expect(command).toContain('"files_uploaded"');
    expect(command).toContain('"files_deleted"');
    expect(command).toContain('"files_remaining"');
    expect(command).toContain('"folders_completed"');
    expect(command).toContain('"current_dataset"');
    expect(command).toContain("def write_progress():");
    expect(command).toContain("temporary.replace(target)");
  });

  it("parses retained upload directories from remote scan output", () => {
    const candidates = parseUploadCandidatesOutput(
      [
        "noise",
        "CANDIDATE\tsia-30-sod-13.5\tjob-1\t/home/jane/solver/results/sia-30-sod-13.5/job-1\t12\t0\tTsumugii/sia-30-sod-13.5",
        "CANDIDATE\t3ia-7.5-3od-8.3\tjob-2\t/home/jane/solver/results/3ia-7.5-3od-8.3/job-2\t0\t4\tTsumugii/3ia-7.5-3od-8.3"
      ].join("\n"),
      "solver-08"
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        id: "solver-08:/home/jane/solver/results/sia-30-sod-13.5/job-1",
        datasetName: "sia-30-sod-13.5",
        repoId: "Tsumugii/sia-30-sod-13.5",
        fileFormat: "parquet",
        fileCount: 12
      }),
      expect.objectContaining({
        datasetName: "3ia-7.5-3od-8.3",
        fileFormat: "json",
        fileCount: 4
      })
    ]);
  });

  it("builds a guarded retained-result deletion command and parses its result", () => {
    const command = buildDeleteUploadCandidateCommand(
      "~/solver",
      "/home/jane/solver/results/sia-30-sod-13.5/job-1"
    );

    expect(command).toContain('RESULTS_ROOT="$HOME/solver/results"');
    expect(command).toContain('ROOT_REAL=$(realpath -e "$RESULTS_ROOT")');
    expect(command).toContain('Refusing to delete a non-job result folder');
    expect(command).toContain('rm -rf -- "$TARGET_REAL"');

    expect(parseDeletedUploadCandidateOutput(
      "DELETED\t/home/jane/solver/results/sia-30-sod-13.5/job-1\tsia-30-sod-13.5\tjob-1\t12\t3\n",
      "solver-08"
    )).toEqual({
      serverId: "solver-08",
      resultsDir: "/home/jane/solver/results/sia-30-sod-13.5/job-1",
      datasetName: "sia-30-sod-13.5",
      jobId: "job-1",
      parquetDeleted: 12,
      jsonDeleted: 3
    });
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
  let scenarioLibraryPath: string;
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
    scenarioLibraryPath = path.join(tempDir, "solver-scenarios.json");
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const repoMatch = url.match(/\/api\/datasets\/([^/?]+)\/([^/?]+)/);
      const repoId = repoMatch
        ? `${decodeURIComponent(repoMatch[1]!)}/${decodeURIComponent(repoMatch[2]!)}`
        : "dataset";
      return new Response(JSON.stringify({ id: repoId }), { status: 200 });
    }));
    commands = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("previews, confirms, creates, and starts a solver job", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
      hfToken: "hf_test_token",
      solverHfProxyUrl: "http://127.0.0.1:7890",
      getHfProxySettings: () => ({ hfProxyEnabled: false, solverHfProxyEnabled: true })
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";

    const preview = await request(app)
      .post("/api/jobs/preview")
      .send({ serverId: "solver-01", rangePath });

    expect(preview.status).toBe(200);
    expect(preview.body.repoId).toBe("Tsumugii/3ia-4.2-3od-4.3");
    expect(preview.body.scenario).toBe("3ia-3od");
    expect(preview.body.remoteRangePath).toBe("/srv/solver/job-ranges/<job-id>/3ia-4.2-3od-4.3.txt");
    expect(preview.body.remoteResultPath).toBe("/srv/solver/results/3ia-4.2-3od-4.3/<job-id>");
    expect(preview.body.requiresConfirmation).toBe(true);
    expect(preview.body.commandPreview).toContain("cd '/srv/solver'");
    expect(preview.body.commandPreview).toContain("'python' 'run_pipeline.py'");
    expect(preview.body.commandPreview).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(preview.body.commandPreview).not.toContain("hf_test_token");
    expect(preview.body.commandPreview).toContain("export http_proxy='http://127.0.0.1:7890'");
    expect(preview.body.commandPreview).toContain("'--scenario' '3ia-3od'");
    expect(preview.body.commandPreview).toContain("'--range-path' '/srv/solver/job-ranges/<job-id>/3ia-4.2-3od-4.3.txt'");
    expect(preview.body.commandPreview).toContain("'--result-path' '/srv/solver/results/3ia-4.2-3od-4.3/<job-id>'");

    const noUploadPreview = await request(app)
      .post("/api/jobs/preview")
      .send({ serverId: "solver-01", rangePath, settings: { uploadEnabled: false, estimateMemory: true } });

    expect(noUploadPreview.status).toBe(200);
    expect(noUploadPreview.body.settings.uploadEnabled).toBe(false);
    expect(noUploadPreview.body.settings.estimateMemory).toBe(false);
    expect(noUploadPreview.body.commandPreview).toContain("'--no-upload'");
    expect(noUploadPreview.body.commandPreview).toContain("'--scenario' '3ia-3od'");
    expect(noUploadPreview.body.commandPreview).toContain("'--range-path' '/srv/solver/job-ranges/<job-id>/3ia-4.2-3od-4.3.txt'");
    expect(noUploadPreview.body.commandPreview).toContain("'--result-path' '/srv/solver/results/3ia-4.2-3od-4.3/<job-id>'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--repo-id'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--upload-format'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--upload-attempt-timeout'");
    expect(noUploadPreview.body.commandPreview).not.toContain("'--estimate-memory'");

    const rejected = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath });

    expect(rejected.status).toBe(409);
    expect(rejected.body.message).toContain("must be approved");

    await approveRange(app, rangePath);

    const approvedPreview = await request(app)
      .post("/api/jobs/preview")
      .send({ serverId: "solver-01", rangePath });
    expect(approvedPreview.status).toBe(200);
    expect(approvedPreview.body.requiresConfirmation).toBe(false);

    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath });

    expect(created.status).toBe(201);
    expect(created.body.job.status).toBe("queued");
    expect(created.body.job.remoteResultPath).toBe(`/srv/solver/results/3ia-4.2-3od-4.3/${created.body.job.id}`);
    expect(created.body.job.command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(created.body.job.command).not.toContain("hf_test_token");

    const queuedRange = await request(app)
      .get("/api/preflop-ranges/file")
      .query({ path: rangePath });
    expect(queuedRange.body.summary.data.runStatus).toBe("queue");

    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);

    expect(started.status).toBe(200);
    expect(started.body.job.status).toBe("running");
    const runningRange = await request(app)
      .get("/api/preflop-ranges/file")
      .query({ path: rangePath });
    expect(runningRange.body.summary.data.runStatus).toBe("running");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("OOP_RANGE");
    expect(commands[0]).toContain(`RANGE_PATH='/srv/solver/job-ranges/${created.body.job.id}/3ia-4.2-3od-4.3.txt'`);
    expect(commands[0]).not.toContain(".bak.");
    expect(commands[1]).toContain("-c '/srv/solver'");
    expect(commands[1]).toContain("tmux send-keys");
    expect(commands[1]).toContain("run_pipeline.py");
    expect(commands[1]).toContain("--scenario");
    expect(commands[1]).toContain("3ia-3od");
    expect(commands[1]).toContain("--range-path");
    expect(commands[1]).toContain(`job-ranges/${created.body.job.id}/3ia-4.2-3od-4.3.txt`);
    expect(commands[1]).toContain("--result-path");
    expect(commands[1]).toContain(`results/3ia-4.2-3od-4.3/${created.body.job.id}`);
    expect(commands[1]).toContain("hf_test_token");

    const list = await request(app).get("/api/jobs");
    expect(list.status).toBe(200);
    expect(list.body.jobs[0]).toMatchObject({
      id: created.body.job.id,
      status: "running",
      repoId: "Tsumugii/3ia-4.2-3od-4.3",
      remoteResultPath: `/srv/solver/results/3ia-4.2-3od-4.3/${created.body.job.id}`
    });
    expect(list.body.jobs[0].command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(list.body.jobs[0].command).not.toContain("hf_test_token");
    expect(JSON.stringify(list.body.events)).not.toContain("hf_test_token");
  });

  it("supports graceful stop followed by force stop", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath });
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

  it("dispatches solver jobs without checking or syncing remote Git state", async () => {
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
    await approveRange(app, rangePath);
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath });

    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);

    expect(started.status).toBe(200);
    expect(started.body.job).toMatchObject({
      id: created.body.job.id,
      status: "running"
    });
    expect(commands.some((command) => command.includes("CODE_READY="))).toBe(false);
    expect(commands.some((command) => command.includes("git pull --rebase"))).toBe(false);
    expect(commands.some((command) => command.includes("run_pipeline.py"))).toBe(true);

    const operations = await request(app).get("/api/server-operations");
    expect(operations.body.operations).toHaveLength(0);
  });

  it("auto-scans online servers before starting retained result uploads", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        if (command.includes("CANDIDATE")) {
          return "CANDIDATE\tsia-30-sod-13.5\tjob-1\t/srv/solver/results/sia-30-sod-13.5/job-1\t5\t2\tTsumugii/sia-30-sod-13.5\n";
        }
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
      hfToken: "hf_test_token",
      solverHfProxyUrl: "http://127.0.0.1:7890",
      getHfProxySettings: () => ({ hfProxyEnabled: false, solverHfProxyEnabled: true })
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const started = await request(app)
      .post("/api/server-operations/upload")
      .send({});

    expect(started.status).toBe(201);
    expect(started.body.operations[0]).toMatchObject({
      type: "upload",
      serverId: "solver-01"
    });
    expect(["deploying", "running"]).toContain(started.body.operations[0].status);
    expect(started.body.operations[0].items).toContainEqual(expect.objectContaining({
      repoId: "Tsumugii/sia-30-sod-13.5",
      resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-1",
      fileFormat: "parquet",
      fileCount: 5
    }));
    expect(started.body.operations[0].items).toContainEqual(expect.objectContaining({
      repoId: "Tsumugii/sia-30-sod-13.5",
      resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-1",
      fileFormat: "json",
      fileCount: 2
    }));
    expect(started.body.operations[0].command).toContain("export HF_TOKEN=$HF_TOKEN");
    expect(started.body.operations[0].command).not.toContain("hf_test_token");
    expect(commands.some((command) => command.includes("find \"$RESULTS_ROOT\""))).toBe(true);
    expect(commands.some((command) => command.includes("tmux send-keys"))).toBe(true);
  });

  it("returns selected bulk uploads before remote tmux startup finishes", async () => {
    let releaseStart: ((value: string) => void) | null = null;
    const startPending = new Promise<string>((resolve) => {
      releaseStart = resolve;
    });
    const executor: SshExecutor = {
      run: vi.fn(async () => startPending)
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const started = await request(app)
      .post("/api/server-operations/upload")
      .send({
        serverIds: ["solver-01"],
        items: [{
          serverId: "solver-01",
          datasetName: "sia-30-sod-13.5",
          repoId: "Tsumugii/sia-30-sod-13.5",
          jobId: "job-1",
          resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-1",
          fileFormat: "parquet",
          fileCount: 12
        }]
      });

    expect(started.status).toBe(201);
    expect(started.body.operations[0]).toMatchObject({ status: "deploying", type: "upload" });
    releaseStart?.("ok");
    await vi.waitFor(() => expect(db.getServerOperation(started.body.operations[0].id)?.status).toBe("running"));
  });

  it("restarts a persisted queued upload through reconciliation", async () => {
    const operation: ServerOperation = {
      ...runningServerOperation(),
      type: "upload",
      status: "queued",
      command: "redacted upload command",
      startedAt: null,
      items: [{
        serverId: "solver-01",
        datasetName: "sia-30-sod-13.5",
        repoId: "Tsumugii/sia-30-sod-13.5",
        jobId: "job-1",
        resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-1",
        fileFormat: "parquet",
        fileCount: 12
      }]
    };
    db.insertServerOperation(operation);
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
      hfToken: "hf_test_token"
    });

    await solverJobService.reconcileAndStartQueuedJobs();

    expect(db.getServerOperation(operation.id)?.status).toBe("running");
    expect(commands[0]).toContain("tmux send-keys");
    expect(commands[0]).toContain("hf_test_token");
  });

  it("deletes one scanned retained-result folder through the selected server", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        return "DELETED\t/srv/solver/results/sia-30-sod-13.5/job-old\tsia-30-sod-13.5\tjob-old\t8\t2\n";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const response = await request(app)
      .delete("/api/server-operations/upload-candidates")
      .send({
        serverId: "solver-01",
        resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-old"
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      serverId: "solver-01",
      resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-old",
      datasetName: "sia-30-sod-13.5",
      jobId: "job-old",
      parquetDeleted: 8,
      jsonDeleted: 2
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("realpath -e");
    expect(commands[0]).toContain('rm -rf -- "$TARGET_REAL"');
  });

  it("bulk deletes selected range folders and reports partial failures", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        commands.push(command);
        if (command.includes("job-failed")) throw new Error("remote delete failed");
        return "DELETED\t/srv/solver/results/sia-30-sod-13.5/job-ready\tsia-30-sod-13.5\tjob-ready\t8\t2\n";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const response = await request(app)
      .delete("/api/server-operations/upload-candidates/bulk")
      .send({
        items: [{
          serverId: "solver-01",
          resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-ready"
        }, {
          serverId: "solver-01",
          resultsDir: "/srv/solver/results/3ia-9-3od-5.8/job-failed"
        }]
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      requested: 2,
      deleted: [{
        serverId: "solver-01",
        datasetName: "sia-30-sod-13.5",
        jobId: "job-ready",
        parquetDeleted: 8,
        jsonDeleted: 2
      }],
      failed: [{
        serverId: "solver-01",
        resultsDir: "/srv/solver/results/3ia-9-3od-5.8/job-failed",
        message: "remote delete failed"
      }]
    });
    expect(commands).toHaveLength(2);
  });

  it("starts manual network sync operations without exposing the subscription URL", async () => {
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
      networkSubscriptionUrl: "https://subscription.example/secret-token",
      giteeUsername: "gitee-login",
      giteeToken: "gitee-secret-token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const started = await request(app)
      .post("/api/server-operations/network-sync")
      .send({ serverIds: ["solver-01"] });

    expect(started.status).toBe(201);
    expect(started.body.operations[0]).toMatchObject({
      type: "network_sync",
      serverId: "solver-01",
      status: "running"
    });
    expect(started.body.operations[0].command).toContain("SUBSCRIPTION_URL=$SUBSCRIPTION_URL");
    expect(started.body.operations[0].command).toContain("GITEE_TOKEN=$GITEE_TOKEN");
    expect(started.body.operations[0].command).not.toContain("secret-token");
    expect(commands.some((command) => command.includes("secret-token"))).toBe(true);
    expect(commands.some((command) => command.includes("gitee-secret-token"))).toBe(true);
    expect(commands.some((command) => command.includes("GIT_ASKPASS_FILE=$(mktemp)"))).toBe(true);
    expect(commands.some((command) => command.includes("tmux send-keys"))).toBe(true);
  });

  it("starts and persists a Hugging Face network check per server", async () => {
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
      solverHfProxyUrl: "http://127.0.0.1:7890",
      getHfProxySettings: () => ({ hfProxyEnabled: false, solverHfProxyEnabled: true })
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const started = await request(app)
      .post("/api/server-operations/network-check")
      .send({ serverIds: ["solver-01"] });

    expect(started.status).toBe(201);
    expect(started.body.operations).toHaveLength(1);
    expect(started.body.operations[0]).toMatchObject({
      type: "network_check",
      serverId: "solver-01",
      status: "running"
    });
    expect(commands.some((command) => command.includes("https://huggingface.co/"))).toBe(true);
    expect(commands.some((command) => command.includes("--proxy"))).toBe(true);
  });

  it("reuses the latest operation ID for a repeated server operation", async () => {
    const executor: SshExecutor = { run: vi.fn(async () => "ok") };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor,
      networkSubscriptionUrl: "https://subscription.example/token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const first = await request(app)
      .post("/api/server-operations/network-sync")
      .send({ serverIds: ["solver-01"] });
    const operationId = first.body.operations[0].id as string;
    db.updateServerOperation(operationId, {
      status: "completed",
      finishedAt: new Date().toISOString()
    });

    const repeated = await request(app)
      .post("/api/server-operations/network-sync")
      .send({ serverIds: ["solver-01"] });

    expect(repeated.status).toBe(201);
    expect(repeated.body.operations).toHaveLength(1);
    expect(repeated.body.operations[0]).toMatchObject({ id: operationId, status: "running" });
  });

  it("retries a failed network operation in place", async () => {
    const previous = {
      ...runningServerOperation(),
      type: "network_sync" as const,
      status: "failed" as const,
      finishedAt: new Date().toISOString(),
      lastError: "Exit code 1"
    };
    db.insertServerOperation(previous);
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
      networkSubscriptionUrl: "https://subscription.example/secret-token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const response = await request(app)
      .post(`/api/server-operations/${previous.id}/retry`)
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.operations).toHaveLength(1);
    expect(response.body.operations[0]).toMatchObject({
      id: previous.id,
      type: "network_sync",
      serverId: "solver-01",
      status: "running"
    });
    expect(commands.some((command) => command.includes("config.yaml.previous"))).toBe(true);
    expect(commands.some((command) => command.includes("pull --rebase"))).toBe(true);
    expect(commands.some((command) => command.includes("secret-token"))).toBe(true);
  });

  it("lists operation records without waiting for SSH reconciliation", async () => {
    const operation = runningServerOperation();
    db.insertServerOperation(operation);
    const executor: SshExecutor = { run: vi.fn(async () => "") };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });

    const response = await request(app).get("/api/server-operations");

    expect(response.status).toBe(200);
    expect(response.body.operations[0]).toMatchObject({ id: operation.id, status: "running" });
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("returns only the latest operation state for each server and operation type", async () => {
    const older = {
      ...runningServerOperation(),
      status: "completed" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z"
    };
    const newer = {
      ...older,
      id: "operation-2",
      status: "failed" as const,
      updatedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:00.000Z",
      lastError: "newer result"
    };
    db.insertServerOperation(older);
    db.insertServerOperation(newer);
    const solverJobService = new SolverJobService({ db, preflopRangesPath });

    const response = await solverJobService.listServerOperations();

    expect(response.operations).toHaveLength(1);
    expect(response.operations[0]).toMatchObject({ id: newer.id, status: "failed", lastError: "newer result" });
  });

  it("marks an active operation failed when its tmux disappeared after restart", async () => {
    const operation = runningServerOperation();
    db.insertServerOperation(operation);
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("OP_TMUX_ALIVE=")) {
          return [
            "OP_STATUS_FILE=1",
            "OP_TMUX_ALIVE=0",
            JSON.stringify({ id: operation.id, status: "running", started_at: operation.startedAt })
          ].join("\n");
        }
        return "ok";
      })
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor
    });

    await solverJobService.reconcileAndStartQueuedJobs();

    expect(db.getServerOperation(operation.id)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("no longer running")
    });
  });

  it("persists incremental upload progress while the remote tmux is running", async () => {
    const operation: ServerOperation = {
      ...runningServerOperation(),
      type: "upload",
      command: "python upload.py",
      items: [{
        serverId: "solver-01",
        datasetName: "sia-30-sod-13.5",
        repoId: "Tsumugii/sia-30-sod-13.5",
        jobId: "job-1",
        resultsDir: "/srv/solver/results/sia-30-sod-13.5/job-1",
        fileFormat: "parquet",
        fileCount: 12
      }]
    };
    db.insertServerOperation(operation);
    const liveResult = {
      summary: {
        folders: 3,
        folders_completed: 1,
        files_found: 36,
        files_deleted: 12,
        files_remaining: 24,
        current_dataset: "sia-30-sod-13.5"
      },
      details: [{
        dataset_name: "sia-30-sod-13.5",
        results_dir: "/srv/solver/results/sia-30-sod-13.5/job-1",
        file_format: "parquet",
        success: true
      }]
    };
    const executor: SshExecutor = {
      run: vi.fn(async () => [
        "OP_STATUS_FILE=1",
        "OP_TMUX_ALIVE=1",
        JSON.stringify({
          id: operation.id,
          type: "upload",
          status: "running",
          started_at: operation.startedAt,
          updated_at: "2026-07-19T03:00:00.000Z",
          result: liveResult
        })
      ].join("\n"))
    };
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      executor
    });

    await solverJobService.reconcileAndStartQueuedJobs();

    expect(db.getServerOperation(operation.id)?.result).toMatchObject(liveResult);
    expect(db.getServerOperation(operation.id)?.status).toBe("running");
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
    expect(preview.body.remoteRangePath).toBe("/srv/solver/job-ranges/<job-id>/sia-45-sod-40.txt");
    expect(preview.body.remoteResultPath).toBe("/srv/solver/results/sia-45-sod-40/<job-id>");
    expect(preview.body.commandPreview).toContain("'--repo-id' 'Tsumugii/sia-45-sod-40'");
    expect(preview.body.commandPreview).toContain("'--scenario' 'sia-sod-open2.5'");
    expect(preview.body.commandPreview).toContain("'--range-path' '/srv/solver/job-ranges/<job-id>/sia-45-sod-40.txt'");
    expect(preview.body.commandPreview).toContain("'--result-path' '/srv/solver/results/sia-45-sod-40/<job-id>'");

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
    expect(overridden.body.remoteRangePath).toBe("/srv/solver/job-ranges/<job-id>/sia-45-sod-40.txt");
    expect(overridden.body.commandPreview).toContain("'--scenario' 'sia-sod-open3'");
  });

  it("manages scenario library and uses custom scenarios in preview", async () => {
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token",
      getScenarioLibrary: () => loadSolverScenarioLibrary(scenarioLibraryPath).scenarios
    });
    const app = createApp({
      db,
      refreshService,
      preflopRangesPath,
      solverScenarioLibraryPath: scenarioLibraryPath,
      solverJobService
    });

    const list = await request(app).get("/api/scenarios");

    expect(list.status).toBe(200);
    expect(list.body.scenarios.map((scenario: { id: string }) => scenario.id)).toContain("sia-sod");

    const added = await request(app)
      .post("/api/scenarios")
      .send({
        scenario: {
          id: "custom-test",
          label: "Custom Test",
          rangeSubdir: "custom-test",
          configTemplate: "SIA_SOD_CONFIG",
          pot: 7,
          effectiveStack: 91,
          description: "Custom test scenario"
        }
      });

    expect(added.status).toBe(201);
    expect(added.body.scenarios).toContainEqual(expect.objectContaining({
      id: "custom-test",
      pot: 7,
      effectiveStack: 91
    }));

    const preview = await request(app)
      .post("/api/jobs/preview")
      .send({
        serverId: "solver-01",
        rangePath: "SOD/2.5bb/SIA-45 vs SOD-40.json",
        scenario: "custom-test",
        datasetName: "custom-dataset"
      });

    expect(preview.status).toBe(200);
    expect(preview.body.scenario).toBe("custom-test");
    expect(preview.body.commandPreview).toContain("'--scenario' 'custom-test'");

    const updated = await request(app)
      .patch("/api/scenarios/custom-test")
      .send({
        scenario: {
          id: "custom-test-renamed",
          label: "Custom Test Renamed",
          rangeSubdir: "custom-test-renamed",
          configTemplate: "SOA_SID_CONFIG",
          pot: 8,
          effectiveStack: 90
        }
      });

    expect(updated.status).toBe(200);
    expect(updated.body.scenarios).toContainEqual(expect.objectContaining({
      id: "custom-test-renamed",
      configTemplate: "SOA_SID_CONFIG"
    }));

    const deleted = await request(app).delete("/api/scenarios/custom-test-renamed");

    expect(deleted.status).toBe(200);
    expect(deleted.body.scenarios.some((scenario: { id: string }) => scenario.id === "custom-test-renamed")).toBe(false);
  });

  it("requires confirmation before creating a missing Hugging Face dataset repo", async () => {
    let repoExists = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/datasets/")) {
        return new Response(JSON.stringify({ id: "Tsumugii/manual-dataset" }), { status: repoExists ? 200 : 404 });
      }
      if (url.includes("/api/repos/create")) {
        repoExists = true;
        return new Response(JSON.stringify({ url: "https://huggingface.co/datasets/Tsumugii/manual-dataset" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
    await approveRange(app, rangePath);

    const check = await request(app)
      .post("/api/jobs/dataset-repo/check")
      .send({ serverId: "solver-01", rangePath, datasetName: "manual-dataset" });

    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      datasetName: "manual-dataset",
      repoId: "Tsumugii/manual-dataset",
      exists: false,
      requiresConfirmation: true
    });

    const rejected = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath, datasetName: "manual-dataset" });

    expect(rejected.status).toBe(409);
    expect(rejected.body.message).toContain("Dataset repo is missing");

    const ensured = await request(app)
      .post("/api/jobs/dataset-repo/ensure")
      .send({
        serverId: "solver-01",
        rangePath,
        datasetName: "manual-dataset",
        confirmDatasetName: true
      });

    expect(ensured.status).toBe(200);
    expect(ensured.body).toMatchObject({
      datasetName: "manual-dataset",
      exists: true,
      created: true,
      requiresConfirmation: false
    });
    const createCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/repos/create"));
    expect(createCall?.[1]?.body).toContain('"organization":"Tsumugii"');
    expect(createCall?.[1]?.body).toContain('"type":"dataset"');

    const created = await request(app)
      .post("/api/jobs")
      .send({
        serverId: "solver-01",
        rangePath,
        datasetName: "manual-dataset",
        confirmDatasetName: true
      });

    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({
      datasetName: "manual-dataset",
      repoId: "Tsumugii/manual-dataset"
    });
  });

  it("treats a renamed backup redirect as missing and creates the exact dataset", async () => {
    const datasetName = "3ia-9-3od-5.8";
    let exactRepoCreated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tree/main")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes(`/api/datasets/Tsumugii/${datasetName}`)) {
        if (exactRepoCreated) {
          return new Response(JSON.stringify({ id: `Tsumugii/${datasetName}` }), { status: 200 });
        }
        return new Response(null, {
          status: 307,
          headers: {
            location: `https://huggingface.co/api/datasets/Tsumugii/${datasetName}-backup`
          }
        });
      }
      if (url.includes("/api/repos/create")) {
        exactRepoCreated = true;
        return new Response(JSON.stringify({
          url: `https://huggingface.co/datasets/Tsumugii/${datasetName}`
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) =>
        command.includes("cards/cards.txt") ? solverCardsText() : "ok"
      )
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
    await approveRange(app, rangePath);

    const check = await request(app)
      .post("/api/jobs/dataset-repo/check")
      .send({ serverId: "solver-01", rangePath, datasetName });

    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      repoId: `Tsumugii/${datasetName}`,
      exists: false,
      requiresConfirmation: true
    });

    const ensured = await request(app)
      .post("/api/jobs/dataset-repo/ensure")
      .send({
        serverId: "solver-01",
        rangePath,
        datasetName,
        confirmDatasetName: true
      });

    expect(ensured.status).toBe(200);
    expect(ensured.body).toMatchObject({
      repoId: `Tsumugii/${datasetName}`,
      exists: true,
      created: true
    });

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({
        rangePath,
        datasetName,
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false }
      });

    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      repoId: `Tsumugii/${datasetName}`,
      repoExists: true,
      missingIndices: expect.any(Array)
    });
    expect(preview.body.missingIndices).toHaveLength(1755);
    const repoChecks = fetchMock.mock.calls.filter(([url]) => String(url).includes(`/api/datasets/Tsumugii/${datasetName}`));
    expect(repoChecks.every((call) => call[1]?.redirect === "manual")).toBe(true);
    const createCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/repos/create"));
    expect(createCall?.[1]?.body).toContain(`\"name\":\"${datasetName}\"`);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`${datasetName}-backup/tree`))).toBe(false);
  });

  it("does not treat a reserved backup redirect as a successful dataset creation", async () => {
    const datasetName = "3ia-9-3od-5.8";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/datasets/Tsumugii/${datasetName}`)) {
        return new Response(null, {
          status: 307,
          headers: {
            location: `https://huggingface.co/api/datasets/Tsumugii/${datasetName}-backup`
          }
        });
      }
      if (url.includes("/api/repos/create")) {
        return new Response(JSON.stringify({ error: "Repository name is reserved" }), { status: 409 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const solverJobService = new SolverJobService({
      db,
      preflopRangesPath,
      credentials: { username: "root", password: "secret" },
      defaultPipelineStatusFilePath: "~/run/solver_running_status.json",
      repoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
    await approveRange(app, rangePath);

    const response = await request(app)
      .post("/api/jobs/dataset-repo/ensure")
      .send({
        serverId: "solver-01",
        rangePath,
        datasetName,
        confirmDatasetName: true
      });

    expect(response.status).toBe(500);
    expect(response.body.message).toContain(`dataset repo creation failed for Tsumugii/${datasetName}`);
    expect(response.body.message).toContain("Repository name is reserved");
    const exactRepoChecks = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes(`/api/datasets/Tsumugii/${datasetName}`)
    );
    expect(exactRepoChecks).toHaveLength(2);
    expect(exactRepoChecks.every((call) => call[1]?.redirect === "manual")).toBe(true);
  });

  it("reconciles an active job when server inventory reports the task is idle", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, "3OD-EP/3OD-4.3 vs 3IA-4.2.json");
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath: "3OD-EP/3OD-4.3 vs 3IA-4.2.json" });
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

  it("fails an active job without attaching a newer unrelated pipeline snapshot", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);
    const created = await request(app).post("/api/jobs").send({ serverId: "solver-01", rangePath });
    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);
    const collectedAt = new Date(Date.parse(started.body.job.startedAt) + 20_000).toISOString();
    db.insertPipelineSnapshot({
      ...runningPipelineSnapshot({
        serverId: "solver-01",
        repoId: "Tsumugii/unrelated-dataset",
        datasetName: "unrelated-dataset",
        assignedIndices: [1, 2, 3]
      }),
      id: "unrelated-active-pipeline",
      collectedAt,
      startedAt: collectedAt,
      updatedAt: collectedAt
    });

    const list = await request(app).get("/api/jobs");

    expect(list.status).toBe(200);
    expect(list.body.jobs[0]).toMatchObject({
      id: created.body.job.id,
      status: "failed",
      pipeline: null
    });
    expect(list.body.jobs[0].lastError).toContain("running a different task");
  });

  it("creates a parallel run, distributes boards, and records failed slices in the failure pool", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], settings: { uploadEnabled: false } });

    expect(preview.status).toBe(200);
    expect(preview.body.sourceType).toBe("parallel");
    expect(preview.body.totalBoards).toBe(1755);
    expect(preview.body.missingIndices).toHaveLength(1755);
    expect(preview.body.allocations).toHaveLength(2);
    expect(preview.body.allocations[0].indices).toHaveLength(878);
    expect(preview.body.allocations[1].indices).toHaveLength(877);
    expect(preview.body.allocations[0].indices.slice(0, 3)).toEqual([1, 3, 5]);
    expect(preview.body.allocations[1].indices.slice(0, 3)).toEqual([2, 4, 6]);
    expect(preview.body.allocations[0].candidateServerIds).toEqual(["solver-01", "solver-02"]);
    expect(preview.body.allocations[1].candidateServerIds).toEqual(["solver-01", "solver-02"]);
    expect(executor.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "solver-01" }),
      { username: "root", password: "secret" },
      expect.stringContaining("cat '/srv/solver/cards/cards.txt'")
    );

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], settings: { uploadEnabled: false }, confirmDatasetName: true });

    expect(created.status).toBe(201);
    expect(created.body.run.slices).toHaveLength(2);
    expect(created.body.run.slices.every((slice: { jobId: string | null }) => slice.jobId)).toBe(true);
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(2);
    expect(commands.join("\n")).toContain("--no-upload");

    const failedSlice = created.body.run.slices[0];
    db.updateSolverJob(failedSlice.jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      lastError: "solver failed"
    });

    const persistedBeforeReconciliation = await request(app).get("/api/parallel-jobs");
    expect(persistedBeforeReconciliation.status).toBe(200);
    expect(persistedBeforeReconciliation.body.failurePool).toEqual([]);

    solverJobService.listParallelJobs();
    const list = await request(app).get("/api/parallel-jobs");
    expect(list.status).toBe(200);
    expect(list.body.runs[0].status).toBe("running");
    expect(list.body.failurePool.length).toBe(failedSlice.assignedIndices.length);
    expect(list.body.failurePool[0]).toMatchObject({
      rangePath,
      datasetName: "3ia-4.2-3od-4.3",
      status: "pending",
      failureReason: "abnormal_end",
      lastServerId: "solver-01"
    });

    const cleared = await request(app)
      .delete("/api/parallel-jobs/failure-pool")
      .query({ rangePath, datasetName: "3ia-4.2-3od-4.3" });

    expect(cleared.status).toBe(200);
    expect(cleared.body.deletedCount).toBe(failedSlice.assignedIndices.length);
    expect(cleared.body.failurePool).toEqual([]);
    expect(cleared.body.runs).toHaveLength(1);
  });

  it("reads every Hugging Face tree page when calculating remote board coverage", async () => {
    const treeRequests: string[] = [];
    const datasetName = "sia-30-sod-28";
    const treeUrl = `https://huggingface.co/api/datasets/Tsumugii/${datasetName}/tree/main`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tree/main")) {
        treeRequests.push(url);
        if (url.includes("cursor=page-2")) {
          return new Response(JSON.stringify(
            Array.from({ length: 605 }, (_value, index) => ({ path: `board-${index + 1000}.parquet` }))
          ), { status: 200 });
        }
        return new Response(JSON.stringify([
          { path: ".gitattributes" },
          ...Array.from({ length: 999 }, (_value, index) => ({ path: `board-${index + 1}.parquet` }))
        ]), {
          status: 200,
          headers: {
            Link: `<${treeUrl}?recursive=true&limit=1000&cursor=page-2>; rel="next"`
          }
        });
      }
      if (url.includes("/api/datasets/")) {
        return new Response(JSON.stringify({ id: `Tsumugii/${datasetName}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) =>
        command.includes("cards/cards.txt") ? solverCardsText() : "ok"
      )
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
    await approveRange(app, rangePath);

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({
        rangePath,
        datasetName,
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false }
      });

    expect(preview.status).toBe(200);
    expect(treeRequests).toHaveLength(2);
    expect(treeRequests[1]).toContain("cursor=page-2");
    expect(preview.body.coverage.remoteCoveredCount).toBe(1604);
    expect(preview.body.coverage.missingCount).toBe(151);
    expect(preview.body.missingIndices).toHaveLength(151);
    expect(preview.body.missingIndices[0]).toBe(1605);
  });

  it("removes remotely covered boards from a stale failure pool before retry preview", async () => {
    const datasetName = "stale-failure-pool";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tree/main")) {
        return new Response(JSON.stringify(
          Array.from({ length: 7 }, (_value, index) => ({ path: `board-${index + 1}.parquet` }))
        ), { status: 200 });
      }
      if (url.includes("/api/datasets/")) {
        return new Response(JSON.stringify({ id: `Tsumugii/${datasetName}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) =>
        command.includes("cards/cards.txt") ? solverCardsText() : "ok"
      )
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
    await approveRange(app, rangePath);
    const now = new Date().toISOString();
    for (let boardIndex = 1; boardIndex <= 10; boardIndex += 1) {
      db.upsertParallelFailurePoolEntry({
        id: `stale-${boardIndex}`,
        rangePath,
        datasetName,
        repoId: `Tsumugii/${datasetName}`,
        scenario: "3ia-3od",
        boardIndex,
        boardName: `board-${boardIndex}`,
        boardKey: `board-${boardIndex}`,
        status: "pending",
        failureReason: "abnormal_end",
        attemptCount: 1,
        lastRunId: "old-run",
        lastSliceId: "old-slice",
        lastServerId: "solver-01",
        lastError: "old failure",
        createdAt: now,
        updatedAt: now
      });
    }

    const preview = await request(app)
      .post("/api/parallel-jobs/failure-pool/preview")
      .send({
        rangePath,
        datasetName,
        serverIds: ["solver-01"],
        chunkCount: 3,
        settings: { uploadEnabled: false }
      });

    expect(preview.status).toBe(200);
    expect(preview.body.missingIndices).toEqual([8, 9, 10]);
    expect(preview.body.allocations).toHaveLength(3);
    expect(preview.body.coverage).toMatchObject({
      remoteCoveredCount: 7,
      failurePoolPendingCount: 3
    });
    await solverJobService.reconcileAndStartQueuedJobs();
    const listed = await request(app).get("/api/parallel-jobs");
    expect(listed.body.failurePool.filter((entry: { status: string }) => entry.status === "solved")).toHaveLength(7);
    expect(listed.body.failurePool.filter((entry: { status: string }) => entry.status === "pending")).toHaveLength(3);
  });

  it("uses one global balanced chunk budget for mixed failure-pool reasons", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      },
      {
        id: "solver-03",
        name: "Solver 03",
        host: "10.0.0.3",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) =>
        command.includes("cards/cards.txt") ? solverCardsText() : "ok"
      )
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
    const datasetName = "mixed-failure-pool";
    await approveRange(app, rangePath);
    const indices = Array.from({ length: 40 }, (_value, index) => index + 1000);
    const now = new Date().toISOString();
    for (const boardIndex of indices) {
      db.upsertParallelFailurePoolEntry({
        id: `mixed-${boardIndex}`,
        rangePath,
        datasetName,
        repoId: `Tsumugii/${datasetName}`,
        scenario: "3ia-3od",
        boardIndex,
        boardName: `board-${boardIndex}`,
        boardKey: `board-${boardIndex}`,
        status: "pending",
        failureReason: boardIndex < 1030 ? "abnormal_end" : "skipped",
        attemptCount: 1,
        lastRunId: "old-run",
        lastSliceId: "old-slice",
        lastServerId: "solver-01",
        lastError: "test failure",
        createdAt: now,
        updatedAt: now
      });
    }

    const preview = await request(app)
      .post("/api/parallel-jobs/failure-pool/preview")
      .send({
        rangePath,
        datasetName,
        indices,
        serverIds: ["solver-01", "solver-02"],
        bestServerId: "solver-03",
        chunkCount: 4,
        settings: { uploadEnabled: false }
      });

    expect(preview.status).toBe(200);
    expect(preview.body.allocations).toHaveLength(4);
    expect(preview.body.allocations.map((allocation: { indices: number[] }) => allocation.indices.length)).toEqual([10, 10, 10, 10]);
    expect(preview.body.allocations.slice(0, 3).every((allocation: { candidateServerIds: string[] }) =>
      JSON.stringify(allocation.candidateServerIds) === JSON.stringify(["solver-01", "solver-02"])
    )).toBe(true);
    expect(preview.body.allocations[3].candidateServerIds).toEqual(["solver-03"]);
  });

  it("sizes parallel chunks from the full enabled server count", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      },
      {
        id: "solver-03",
        name: "Solver 03",
        host: "10.0.0.3",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      },
      {
        id: "solver-04",
        name: "Solver 04",
        host: "10.0.0.4",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
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
    await approveRange(app, rangePath);

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], settings: { uploadEnabled: false } });

    expect(preview.status).toBe(200);
    expect(preview.body.allocations).toHaveLength(4);
    expect(preview.body.allocations.map((allocation: { server: { id: string }; candidateServerIds: string[]; indices: number[] }) => ({
      serverId: allocation.server.id,
      candidateServerIds: allocation.candidateServerIds,
      firstIndices: allocation.indices.slice(0, 4)
    }))).toEqual([
      { serverId: "solver-01", candidateServerIds: ["solver-01", "solver-02"], firstIndices: [1, 5, 9, 13] },
      { serverId: "solver-02", candidateServerIds: ["solver-01", "solver-02"], firstIndices: [2, 6, 10, 14] },
      { serverId: "solver-01", candidateServerIds: ["solver-01", "solver-02"], firstIndices: [3, 7, 11, 15] },
      { serverId: "solver-02", candidateServerIds: ["solver-01", "solver-02"], firstIndices: [4, 8, 12, 16] }
    ]);

    const customPreview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], chunkCount: 3, settings: { uploadEnabled: false } });

    expect(customPreview.status).toBe(200);
    expect(customPreview.body.allocations).toHaveLength(3);
    expect(customPreview.body.allocations.map((allocation: { indices: number[] }) => allocation.indices.slice(0, 3))).toEqual([
      [1, 4, 7],
      [2, 5, 8],
      [3, 6, 9]
    ]);
  });

  it("rejects a parallel preview when online servers have inconsistent solver cards", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) {
          return solverCardsText(server.id === "solver-02" ? 756 : 1755);
        }
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
    await approveRange(app, rangePath);

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], settings: { uploadEnabled: false } });

    expect(preview.status).toBe(500);
    expect(preview.body.message).toContain("Remote solver cards.txt is inconsistent");
    expect(preview.body.message).toContain("solver-01=1755 boards");
    expect(preview.body.message).toContain("solver-02=756 boards");
  });

  it("rejects a parallel preview when every reachable cards file has the wrong board count", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) =>
        command.includes("cards/cards.txt") ? solverCardsText(756) : "ok"
      )
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
    await approveRange(app, rangePath);

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({ rangePath, serverIds: ["solver-01"], settings: { uploadEnabled: false } });

    expect(preview.status).toBe(500);
    expect(preview.body.message).toContain("must contain 1755 boards");
    expect(preview.body.message).toContain("contains 756");
  });

  it("keeps a queued slice pending when a server cards file changes before dispatch", async () => {
    let staleCards = false;
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText(staleCards ? 756 : 1755);
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);
    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });
    expect(created.status).toBe(201);

    staleCards = true;
    const refreshed = await request(app).get("/api/parallel-jobs?reconcile=1");
    expect(refreshed.body.reconciling).toBe(true);
    await solverJobService.reconcileAndStartQueuedJobs();
    const settled = await request(app).get("/api/parallel-jobs");

    expect(settled.status).toBe(200);
    expect(settled.body.runs[0].status).toBe("queued");
    expect(settled.body.runs[0].slices[0].status).toBe("queued");
    expect(settled.body.runs[0].slices[0].lastError).toContain("must contain 1755 boards");
    expect(commands.some((command) => command.includes("run_pipeline.py"))).toBe(false);
  });

  it("returns unresolved boards to the failure pool when a queued parallel run is canceled", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });
    expect(created.status).toBe(201);

    const canceled = await request(app).post(`/api/parallel-jobs/${created.body.run.id}/cancel`);

    expect(canceled.status).toBe(200);
    expect(canceled.body.run.status).toBe("canceled");
    expect(canceled.body.failurePool).toHaveLength(1755);
    expect(canceled.body.failurePool[0]).toMatchObject({
      status: "pending",
      failureReason: "abnormal_end",
      lastRunId: created.body.run.id
    });
  });

  it("keeps a parallel slice locked while remote cancellation is still pending", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
        if (command.includes("PIPELINE_ALIVE=")) return "PIPELINE_ALIVE=1\n";
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true
      });
    expect(created.status).toBe(201);

    const cancelPending = await request(app).post(`/api/parallel-jobs/${created.body.run.id}/cancel`);

    expect(cancelPending.status).toBe(200);
    expect(cancelPending.body.run.status).toBe("running");
    expect(cancelPending.body.run.slices[0].status).toBe("running");
    expect(cancelPending.body.run.slices[0].job.status).toBe("stopping");
    expect(cancelPending.body.failurePool).toEqual([]);
  });

  it("previews parallel allocation when enabled servers are busy but not available", async () => {
    db.insertPipelineSnapshot({
      ...idlePipelineSnapshot("solver-01", new Date().toISOString()),
      id: "solver-01-running",
      processAlive: true,
      fileStatus: "running",
      displayStatus: "running",
      repoId: "Tsumugii/busy-dataset",
      datasetName: "busy-dataset",
      startedAt: new Date().toISOString(),
      command: "python run_pipeline.py all"
    });
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
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
    await approveRange(app, rangePath);

    const preview = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({ rangePath, settings: { uploadEnabled: false } });

    expect(preview.status).toBe(200);
    expect(preview.body.availableServers).toHaveLength(0);
    expect(preview.body.selectedServerIds).toEqual(["solver-01"]);
    expect(preview.body.allocations).toHaveLength(1);
    expect(preview.body.allocations[0]).toMatchObject({
      server: expect.objectContaining({ id: "solver-01" }),
      candidateServerIds: ["solver-01"]
    });
  });

  it("routes skipped failure-pool boards to the configured best server", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      },
      {
        id: "solver-03",
        name: "Solver 03",
        host: "10.0.0.3",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    db.insertSnapshot(metricSnapshot("solver-03", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], settings: { uploadEnabled: false }, confirmDatasetName: true });
    expect(created.status).toBe(201);
    const failedSlice = created.body.run.slices[0];
    const skippedIndex = failedSlice.assignedIndices[0];
    const abnormalIndex = failedSlice.assignedIndices[1];
    db.insertPipelineSnapshot(failedPipelineSnapshot({
      serverId: failedSlice.serverId,
      repoId: created.body.run.repoId,
      datasetName: created.body.run.datasetName,
      assignedIndices: failedSlice.assignedIndices,
      completedIndices: [],
      failedIndices: [skippedIndex, abnormalIndex],
      skippedIndices: [skippedIndex]
    }));
    db.updateSolverJob(failedSlice.jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      lastError: "board skipped"
    });

    solverJobService.listParallelJobs();
    const listed = await request(app).get("/api/parallel-jobs");
    expect(listed.body.failurePool.find((entry: { boardIndex: number }) => entry.boardIndex === skippedIndex)).toMatchObject({
      failureReason: "skipped",
      status: "pending"
    });
    expect(listed.body.failurePool.find((entry: { boardIndex: number }) => entry.boardIndex === abnormalIndex)).toMatchObject({
      failureReason: "abnormal_end",
      status: "pending"
    });

    const poolPreview = await request(app)
      .post("/api/parallel-jobs/failure-pool/preview")
      .send({
        rangePath,
        indices: [skippedIndex],
        serverIds: ["solver-01"],
        bestServerId: "solver-03",
        settings: { uploadEnabled: false }
      });

    expect(poolPreview.status).toBe(200);
    expect(poolPreview.body).toMatchObject({
      sourceType: "failure_pool",
      totalBoards: 1755,
      missingIndices: [skippedIndex]
    });

    const retryRequest = {
      rangePath,
      indices: [skippedIndex],
      serverIds: ["solver-01"],
      bestServerId: "solver-03",
      settings: { uploadEnabled: false },
      confirmDatasetName: true,
      queueMode: "queue_next"
    };
    const firstRetry = await request(app)
      .post("/api/parallel-jobs/failure-pool/submit")
      .send(retryRequest);

    expect(firstRetry.status).toBe(201);
    expect(firstRetry.body.run.sourceType).toBe("failure_pool");
    expect(firstRetry.body.run.slices).toHaveLength(1);
    expect(firstRetry.body.run.slices[0]).toMatchObject({
      serverId: "",
      candidateServerIds: ["solver-03"],
      rangeExpr: String(skippedIndex)
    });
    expect(firstRetry.body.failurePool.find((entry: { boardIndex: number }) => entry.boardIndex === skippedIndex).status).toBe("queued");

    const deletedRetry = await request(app).delete(`/api/parallel-jobs/${firstRetry.body.run.id}`);
    expect(deletedRetry.status).toBe(200);
    expect(deletedRetry.body.failurePool.find((entry: { boardIndex: number }) => entry.boardIndex === skippedIndex).status).toBe("pending");

    const retry = await request(app)
      .post("/api/parallel-jobs/failure-pool/submit")
      .send(retryRequest);
    expect(retry.status).toBe(201);

    await solverJobService.reconcileAndStartQueuedJobs();
    const afterDispatch = await request(app).get("/api/parallel-jobs");
    const retryRun = afterDispatch.body.runs.find((run: { id: string }) => run.id === retry.body.run.id);
    expect(retryRun.slices[0]).toMatchObject({
      serverId: "solver-03",
      candidateServerIds: ["solver-03"],
      status: "running"
    });
  });

  it("keeps failed parallel dispatches queued until the server passes SSH preflight", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    let solver02Ready = false;
    const executor: SshExecutor = {
      run: vi.fn(async (server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (isCodeReadyCommand(command)) return codeReadyOutput();
        if (command.includes("DISPATCH_READY")) {
          if (server.id === "solver-02" && !solver02Ready) {
            throw new Error("ssh connect failed");
          }
          return "DISPATCH_READY=1\n";
        }
        commands.push(`${server.id}:${command}`);
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({ rangePath, serverIds: ["solver-01", "solver-02"], settings: { uploadEnabled: false }, confirmDatasetName: true });

    expect(created.status).toBe(201);
    expect(created.body.run.status).toBe("running");
    expect(created.body.run.slices.map((slice: { serverId: string; status: string }) => [slice.serverId, slice.status])).toEqual([
      ["solver-01", "running"],
      ["solver-02", "queued"]
    ]);
    const pendingSlice = created.body.run.slices.find((slice: { serverId: string }) => slice.serverId === "solver-02");
    expect(pendingSlice.job.lastError).toContain("SSH preflight failed");
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(1);

    solver02Ready = true;

    const afterRetry = await request(app).get("/api/parallel-jobs?reconcile=1");
    expect(afterRetry.status).toBe(200);
    expect(afterRetry.body.reconciling).toBe(true);
    await solverJobService.reconcileAndStartQueuedJobs();
    const settled = await request(app).get("/api/parallel-jobs");
    const run = settled.body.runs.find((candidate: { id: string }) => candidate.id === created.body.run.id);
    expect(run.slices.map((slice: { serverId: string; status: string }) => [slice.serverId, slice.status])).toEqual([
      ["solver-01", "running"],
      ["solver-02", "running"]
    ]);
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(2);
  });

  it("reconciles queued parallel slices when server inventory reports the matching task is running", async () => {
    let preflightReady = false;
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) {
          return preflightReady ? "DISPATCH_READY=1\n" : "DISPATCH_READY=0\nDISPATCH_REASON=busy\n";
        }
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({ rangePath, serverIds: ["solver-01"], settings: { uploadEnabled: false }, confirmDatasetName: true });

    expect(created.status).toBe(201);
    expect(created.body.run.slices[0]).toMatchObject({ serverId: "solver-01", status: "queued" });
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(0);

    db.insertPipelineSnapshot(runningPipelineSnapshot({
      serverId: "solver-01",
      repoId: created.body.run.repoId,
      datasetName: created.body.run.datasetName,
      assignedIndices: created.body.run.slices[0].assignedIndices,
      completedIndices: created.body.run.slices[0].assignedIndices.slice(0, 3)
    }));

    preflightReady = true;
    const refreshRequested = await request(app).get("/api/parallel-jobs?reconcile=1");
    expect(refreshRequested.status).toBe(200);
    expect(refreshRequested.body.reconciling).toBe(true);
    await solverJobService.reconcileAndStartQueuedJobs();
    const reconciled = await request(app).get("/api/parallel-jobs");
    expect(reconciled.status).toBe(200);
    const run = reconciled.body.runs.find((candidate: { id: string }) => candidate.id === created.body.run.id);
    expect(run.slices[0]).toMatchObject({
      serverId: "solver-01",
      status: "running",
      completedCount: 3,
      lastError: null
    });
    expect(run.slices[0].job).toMatchObject({
      status: "running",
      lastError: null
    });
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(0);
  });

  it("reassigns higher priority pending parallel chunks before dispatching lower priority runs", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) {
          return server.id === "solver-02"
            ? "DISPATCH_READY=0\nDISPATCH_REASON=busy\n"
            : "DISPATCH_READY=1\n";
        }
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const first = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-a",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true
      });
    expect(first.status).toBe(201);
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(1);
    const firstRunningSlice = first.body.run.slices.find((slice: { status: string }) => slice.status === "running");
    expect(firstRunningSlice.serverId).toBe("solver-01");
    db.updateSolverJob(firstRunningSlice.jobId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      lastError: null
    });
    solverJobService.listParallelJobs();

    const second = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-b",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });
    expect(second.status).toBe(201);

    await solverJobService.reconcileAndStartQueuedJobs();

    const commandsText = commands.filter((command) => command.includes("run_pipeline.py")).join("\n");
    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(2);
    expect(commandsText).toContain("/results/parallel-a/");
    expect(commandsText).not.toContain("/results/parallel-b/");
    expect(db.getActiveSolverJobForServer("solver-01")?.datasetName).toBe("parallel-a");
    const runA = solverJobService.listParallelJobs().runs.find((run) => run.id === first.body.run.id);
    expect(runA?.slices.filter((slice) => slice.status === "running").map((slice) => slice.serverId)).toEqual(["solver-01"]);
  });

  it("queues parallel runs, reorders movable runs, and starts servers in queue order", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const first = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-a",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });
    const second = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-b",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(commands).toHaveLength(0);

    const reordered = await request(app)
      .post("/api/parallel-jobs/reorder")
      .send({ runIds: [second.body.run.id, first.body.run.id] });

    expect(reordered.status).toBe(200);
    expect(reordered.body.runs.slice(0, 2).map((run: { id: string }) => run.id)).toEqual([
      second.body.run.id,
      first.body.run.id
    ]);

    await solverJobService.reconcileAndStartQueuedJobs();

    expect(commands.filter((command) => command.includes("run_pipeline.py"))).toHaveLength(2);
    expect(db.getActiveSolverJobForServer("solver-01")?.datasetName).toBe("parallel-b");
    expect(db.getActiveSolverJobForServer("solver-02")?.datasetName).toBe("parallel-b");
  });

  it("keeps running parallel runs locked while reordering later queued runs", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
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
    await approveRange(app, rangePath);
    const createdRuns: Array<{ id: string; slices: Array<{ id: string }> }> = [];
    for (const datasetName of ["parallel-a", "parallel-b", "parallel-c", "parallel-d"]) {
      const created = await request(app)
        .post("/api/parallel-jobs")
        .send({
          rangePath,
          datasetName,
          serverIds: ["solver-01"],
          settings: { uploadEnabled: false },
          confirmDatasetName: true,
          queueMode: "queue_next"
        });
      expect(created.status).toBe(201);
      createdRuns.push(created.body.run);
    }

    const [runA, runB, runC, runD] = createdRuns;
    for (const run of [runA, runB]) {
      db.updateParallelSolverSlice(run.slices[0].id, {
        serverId: "solver-01",
        status: "running",
        startedAt: new Date().toISOString()
      });
      db.updateParallelSolverRun(run.id, {
        status: "running",
        startedAt: new Date().toISOString()
      });
    }

    const reordered = await request(app)
      .post("/api/parallel-jobs/reorder")
      .send({ runIds: [runD.id, runC.id] });

    expect(reordered.status).toBe(200);
    expect(reordered.body.runs.slice(0, 4).map((run: { datasetName: string }) => run.datasetName)).toEqual([
      "parallel-a",
      "parallel-b",
      "parallel-d",
      "parallel-c"
    ]);
  });

  it("deletes only non-locked queued parallel runs", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
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
    await approveRange(app, rangePath);

    const queued = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-delete-me",
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });

    expect(queued.status).toBe(201);
    const deleted = await request(app).delete(`/api/parallel-jobs/${queued.body.run.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedRunId).toBe(queued.body.run.id);
    expect(deleted.body.runs.some((run: { id: string }) => run.id === queued.body.run.id)).toBe(false);

    const running = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-locked",
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });
    db.updateParallelSolverSlice(running.body.run.slices[0].id, {
      serverId: "solver-01",
      status: "running",
      startedAt: new Date().toISOString()
    });
    db.updateParallelSolverRun(running.body.run.id, {
      status: "running",
      startedAt: new Date().toISOString()
    });

    const rejected = await request(app).delete(`/api/parallel-jobs/${running.body.run.id}`);
    expect(rejected.status).toBe(409);
  });

  it("keeps completed parallel history bound to its terminal pipeline snapshot", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-history-stable",
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true
      });
    expect(created.status).toBe(201);
    const slice = created.body.run.slices[0] as { jobId: string; assignedIndices: number[]; serverId: string };
    const completedSnapshot: PipelineStatusSnapshot = {
      ...failedPipelineSnapshot({
        serverId: slice.serverId,
        repoId: created.body.run.repoId,
        datasetName: created.body.run.datasetName,
        assignedIndices: slice.assignedIndices,
        completedIndices: slice.assignedIndices,
        failedIndices: []
      }),
      id: "history-terminal-snapshot",
      fileStatus: "completed",
      displayStatus: "completed",
      completedCount: slice.assignedIndices.length,
      failedCount: 0,
      error: null,
      errorCode: null,
      errorMessage: null
    };
    db.insertPipelineSnapshot(completedSnapshot);
    db.updateSolverJob(slice.jobId, {
      status: "completed",
      finishedAt: completedSnapshot.finishedAt,
      lastError: null
    });

    const completedRun = solverJobService.listParallelJobs().runs.find((run) => run.id === created.body.run.id);
    expect(completedRun).toMatchObject({
      status: "completed",
      report: {
        totalBoards: 1755,
        completedBoards: 1755,
        failedBoards: 0,
        successRate: 1
      }
    });
    expect(completedRun?.slices[0]?.job?.pipeline?.id).toBe(completedSnapshot.id);

    const laterCollectedAt = new Date(Date.parse(completedSnapshot.collectedAt) + 60_000).toISOString();
    db.insertPipelineSnapshot({
      ...runningPipelineSnapshot({
        serverId: slice.serverId,
        repoId: "Tsumugii/later-dataset",
        datasetName: "later-dataset",
        assignedIndices: [1, 2, 3],
        completedIndices: [1]
      }),
      id: "later-unrelated-snapshot",
      collectedAt: laterCollectedAt,
      startedAt: laterCollectedAt,
      updatedAt: laterCollectedAt
    });

    const afterLaterTask = solverJobService.listParallelJobs().runs.find((run) => run.id === created.body.run.id);
    expect(afterLaterTask?.report).toMatchObject({
      totalBoards: 1755,
      completedBoards: 1755,
      failedBoards: 0,
      successRate: 1
    });
    expect(afterLaterTask?.slices[0]?.job?.pipeline?.id).toBe(completedSnapshot.id);
  });

  it("deletes terminal parallel history with its jobs, slices, events, and linked failure pool", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const created = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-delete-history",
        serverIds: ["solver-01"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true
      });
    const runId = String(created.body.run.id);
    const slice = created.body.run.slices[0] as { id: string; jobId: string; assignedIndices: number[] };
    db.updateSolverJob(slice.jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      lastError: "abnormal end"
    });
    const terminalRun = solverJobService.listParallelJobs().runs.find((run) => run.id === runId);
    expect(terminalRun?.status).toBe("completed_with_failures");
    expect(db.getParallelFailurePoolEntries(rangePath, "parallel-delete-history")).toHaveLength(1755);
    expect(db.getSolverJobEvents(slice.jobId).length).toBeGreaterThan(0);

    const deleted = await request(app).delete(`/api/parallel-jobs/${runId}`);

    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      deletedRunId: runId,
      deletedFailurePoolEntries: 1755
    });
    expect(db.getParallelSolverRun(runId)).toBeNull();
    expect(db.getParallelSolverSlices(runId)).toEqual([]);
    expect(db.getSolverJobs().some((job) => job.parallelRunId === runId)).toBe(false);
    expect(db.getSolverJobEvents(slice.jobId)).toEqual([]);
    expect(db.getParallelFailurePoolEntries(rangePath, "parallel-delete-history")).toEqual([]);
  });

  it("clears only retryable failure entries for the selected range and dataset", async () => {
    const solverJobService = new SolverJobService({ db, preflopRangesPath });
    const app = createApp({ db, refreshService, preflopRangesPath, solverJobService });
    const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
    const datasetName = "selected-failure-pool";
    const now = new Date().toISOString();
    const failureEntry = (
      id: string,
      entryDatasetName: string,
      boardIndex: number,
      status: ParallelFailurePoolEntry["status"]
    ): ParallelFailurePoolEntry => ({
      id,
      rangePath,
      datasetName: entryDatasetName,
      repoId: `Tsumugii/${entryDatasetName}`,
      scenario: "3ia-3od",
      boardIndex,
      boardName: `board-${boardIndex}`,
      boardKey: `board-${boardIndex}`,
      status,
      failureReason: "abnormal_end",
      attemptCount: 1,
      lastRunId: "old-run",
      lastSliceId: "old-slice",
      lastServerId: "solver-01",
      lastError: "failure",
      createdAt: now,
      updatedAt: now
    });
    db.upsertParallelFailurePoolEntry(failureEntry("selected-pending", datasetName, 1, "pending"));
    db.upsertParallelFailurePoolEntry(failureEntry("selected-queued", datasetName, 2, "queued"));
    db.upsertParallelFailurePoolEntry(failureEntry("selected-failed", datasetName, 3, "failed"));
    db.upsertParallelFailurePoolEntry(failureEntry("selected-solved", datasetName, 4, "solved"));
    db.upsertParallelFailurePoolEntry(failureEntry("other-pending", "other-dataset", 1, "pending"));

    const rejectedGlobalClear = await request(app).delete("/api/parallel-jobs/failure-pool");
    expect(rejectedGlobalClear.status).toBe(400);
    expect(db.getParallelFailurePoolEntries()).toHaveLength(5);

    const cleared = await request(app)
      .delete("/api/parallel-jobs/failure-pool")
      .query({ rangePath, datasetName });

    expect(cleared.status).toBe(200);
    expect(cleared.body.deletedCount).toBe(2);
    expect(db.getParallelFailurePoolEntries(rangePath, datasetName).map((entry) => entry.status)).toEqual([
      "queued",
      "solved"
    ]);
    expect(db.getParallelFailurePoolEntries(rangePath, "other-dataset")).toHaveLength(1);
  });

  it("clears only terminal parallel reports", async () => {
    db.syncServers([
      ...servers,
      {
        id: "solver-02",
        name: "Solver 02",
        host: "10.0.0.2",
        port: 22,
        enabled: true,
        note: "TBD",
        solverRoot: "/srv/solver",
        tmuxSession: "solver",
        pipelineStatusFilePath: "~/run/status.json"
      }
    ]);
    db.insertSnapshot(metricSnapshot("solver-02", "online"));
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (command.includes("cards/cards.txt")) return solverCardsText();
        if (command.includes("DISPATCH_READY")) return "DISPATCH_READY=1\n";
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, rangePath);

    const completed = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-completed",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true
      });
    const queued = await request(app)
      .post("/api/parallel-jobs")
      .send({
        rangePath,
        datasetName: "parallel-queued",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false },
        confirmDatasetName: true,
        queueMode: "queue_next"
      });

    expect(completed.status).toBe(201);
    expect(queued.status).toBe(201);
    for (const slice of completed.body.run.slices as Array<{ jobId: string }>) {
      db.updateSolverJob(slice.jobId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        lastError: null
      });
    }

    solverJobService.listParallelJobs();
    const beforeClear = await request(app).get("/api/parallel-jobs");
    expect(beforeClear.body.runs.some((run: { id: string; status: string }) =>
      run.id === completed.body.run.id && run.status === "completed"
    )).toBe(true);

    const cleared = await request(app).delete("/api/parallel-jobs/reports");

    expect(cleared.status).toBe(200);
    expect(cleared.body.deletedRunIds).toEqual([completed.body.run.id]);
    expect(cleared.body.deletedCount).toBe(1);
    expect(cleared.body.runs.map((run: { id: string }) => run.id)).toEqual([queued.body.run.id]);
    expect(cleared.body.runs[0].status).toBe("queued");
    expect(db.getSolverJobs().some((job) => job.parallelRunId === completed.body.run.id)).toBe(true);
    expect(db.getParallelSolverRun(completed.body.run.id)?.reportCleared).toBe(true);

    const previewAfterClear = await request(app)
      .post("/api/parallel-jobs/preview")
      .send({
        rangePath,
        datasetName: "parallel-completed",
        serverIds: ["solver-01", "solver-02"],
        settings: { uploadEnabled: false }
      });
    expect(previewAfterClear.status).toBe(200);
    expect(previewAfterClear.body.missingIndices).toEqual([]);
    expect(previewAfterClear.body.coverage.historicallyCompletedCount).toBe(1755);
  });

  it("rejects job operations while the server is offline", async () => {
    const executor: SshExecutor = {
      run: vi.fn(async (_server, _credentials, command) => {
        if (isCodeReadyCommand(command)) return codeReadyOutput();
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
    await approveRange(app, "3OD-EP/3OD-4.3 vs 3IA-4.2.json");
    const created = await request(app)
      .post("/api/jobs")
      .send({ serverId: "solver-01", rangePath: "3OD-EP/3OD-4.3 vs 3IA-4.2.json" });
    const started = await request(app).post(`/api/jobs/${created.body.job.id}/start`);
    db.insertSnapshot(metricSnapshot("solver-01", "offline", new Date(Date.now() + 60_000).toISOString()));

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
    assignedIndices: [],
    completedIndices: [],
    failedIndices: [],
    skippedIndices: [],
    completedCount: null,
    failedCount: null,
    skippedCount: null,
    resultPath: null,
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

function runningPipelineSnapshot({
  serverId,
  repoId,
  datasetName,
  assignedIndices,
  completedIndices = []
}: {
  serverId: string;
  repoId: string;
  datasetName: string;
  assignedIndices: number[];
  completedIndices?: number[];
}): PipelineStatusSnapshot {
  const collectedAt = new Date().toISOString();
  return {
    id: `${serverId}-running-${collectedAt}`,
    serverId,
    collectedAt,
    available: true,
    processAlive: true,
    fileStatus: "running",
    displayStatus: "running",
    phase: "solving",
    repoId,
    datasetName,
    scenario: "3ia-3od",
    currentBatch: 1,
    totalBatches: null,
    totalTasks: assignedIndices.length,
    batchExpr: null,
    assignedIndices,
    completedIndices,
    failedIndices: [],
    skippedIndices: [],
    completedCount: completedIndices.length,
    failedCount: 0,
    skippedCount: 0,
    resultPath: null,
    pid: 1234,
    startedAt: collectedAt,
    updatedAt: collectedAt,
    finishedAt: null,
    command: "python run_pipeline.py all",
    error: null,
    errorCode: null,
    errorMessage: null
  };
}

function failedPipelineSnapshot({
  serverId,
  repoId,
  datasetName,
  assignedIndices,
  completedIndices,
  failedIndices,
  skippedIndices = []
}: {
  serverId: string;
  repoId: string;
  datasetName: string;
  assignedIndices: number[];
  completedIndices: number[];
  failedIndices: number[];
  skippedIndices?: number[];
}): PipelineStatusSnapshot {
  const collectedAt = new Date().toISOString();
  return {
    id: `${serverId}-failed-${collectedAt}`,
    serverId,
    collectedAt,
    available: true,
    processAlive: false,
    fileStatus: "failed",
    displayStatus: "failed",
    phase: null,
    repoId,
    datasetName,
    scenario: "3ia-3od",
    currentBatch: null,
    totalBatches: null,
    totalTasks: assignedIndices.length,
    batchExpr: null,
    assignedIndices,
    completedIndices,
    failedIndices,
    skippedIndices,
    completedCount: completedIndices.length,
    failedCount: failedIndices.length,
    skippedCount: skippedIndices.length,
    resultPath: null,
    pid: null,
    startedAt: collectedAt,
    updatedAt: collectedAt,
    finishedAt: collectedAt,
    command: null,
    error: "board skipped",
    errorCode: "solver_failed",
    errorMessage: "board skipped"
  };
}

async function approveRange(app: ReturnType<typeof createApp>, rangePath: string): Promise<void> {
  const response = await request(app)
    .post("/api/preflop-ranges/status")
    .send({ path: rangePath, status: "approved" });
  expect(response.status).toBe(200);
}

function runningServerOperation(): ServerOperation {
  const now = new Date().toISOString();
  return {
    id: "operation-1",
    type: "sync",
    serverId: "solver-01",
    status: "running",
    tmuxSession: "sync-solver-01-operation",
    command: "git pull --rebase",
    items: [{ serverId: "solver-01", solverRoot: "/srv/solver" }],
    statusFilePath: "~/run/server_operation_operation-1.json",
    logFilePath: "~/run/server_operation_operation-1.log",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    lastError: null,
    result: null
  };
}

function solverCardsText(count = 1755): string {
  return Array.from({ length: count }, (_value, index) => `board-${index + 1}`).join("\n");
}

function isCodeReadyCommand(command: string): boolean {
  return command.includes("CODE_READY=") && command.includes("git fetch --quiet");
}

function codeReadyOutput(): string {
  return "CODE_READY=1\nCODE_REASON=up to date\n";
}
