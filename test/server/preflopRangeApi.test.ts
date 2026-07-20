import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/api";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";

describe("preflop range API", () => {
  let tempDir: string;
  let preflopRangesPath: string;
  let db: MonitorDatabase;
  let service: RefreshService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-preflop-"));
    preflopRangesPath = path.join(tempDir, "preflop-ranges");
    fs.mkdirSync(path.join(preflopRangesPath, "3OD-EP"), { recursive: true });
    fs.writeFileSync(
      path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json"),
      JSON.stringify({
        player_names: { A: "3OD-4.3", B: "3IA-4.2" },
        player_positions: { A: "OOP", B: "IP" },
        learned: false,
        A: { raise: "AA,AKs:0.500", call: "" },
        B: { raise: "", call: "AQs:0.250" }
      })
    );

    db = await MonitorDatabase.createInMemory();
    service = new RefreshService({
      db,
      servers: [],
      intervalMs: 3_600_000,
      collect: async () => {
        throw new Error("not used");
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists and reads converted JSON range files", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    const listResponse = await request(app).get("/api/preflop-ranges");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.tree[0]).toMatchObject({ type: "folder", name: "3OD-EP" });
    expect(listResponse.body.tree[0].children[0]).toMatchObject({
      type: "file",
      name: "3OD-4.3 vs 3IA-4.2.json",
      learned: false
    });

    const fileResponse = await request(app)
      .get("/api/preflop-ranges/file")
      .query({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json" });
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.body.summary.players.A.position).toBe("OOP");
    expect(fileResponse.body.summary.players.A.matrix.AKs.raise).toBe(0.5);
  });

  it("updates learned status in local metadata without changing the range file", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });
    const rangeFile = path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json");
    const before = fs.readFileSync(rangeFile, "utf8");

    const response = await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", learned: true });

    expect(response.status).toBe(200);
    expect(response.body.summary.data.learned).toBe(true);
    expect(response.body.summary.data.status).toBe("approved");
    expect(fs.readFileSync(rangeFile, "utf8")).toBe(before);

    const metadata = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_status.json"), "utf8"));
    expect(metadata.ranges["3OD-EP/3OD-4.3 vs 3IA-4.2.json"].reviewStatus).toBe("approved");
    expect(metadata.ranges["3OD-EP/3OD-4.3 vs 3IA-4.2.json"].runStatus).toBe("idle");

    const listResponse = await request(app).get("/api/preflop-ranges");
    expect(listResponse.body.tree[0].children[0]).toMatchObject({
      learned: true,
      status: "approved",
      reviewStatus: "approved",
      runStatus: "idle"
    });
  });

  it("updates review status in local metadata without changing the range file", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });
    const rangeFile = path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json");
    const before = fs.readFileSync(rangeFile, "utf8");

    const response = await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", status: "has_problem" });

    expect(response.status).toBe(200);
    expect(response.body.summary.data.status).toBe("has_problem");
    expect(response.body.summary.data.learned).toBe(false);
    expect(fs.readFileSync(rangeFile, "utf8")).toBe(before);

    const metadata = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_status.json"), "utf8"));
    expect(metadata.ranges["3OD-EP/3OD-4.3 vs 3IA-4.2.json"].reviewStatus).toBe("has_problem");
    expect(metadata.ranges["3OD-EP/3OD-4.3 vs 3IA-4.2.json"].runStatus).toBe("idle");

    const fileResponse = await request(app)
      .get("/api/preflop-ranges/file")
      .query({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json" });
    expect(fileResponse.body.summary.data.status).toBe("has_problem");
    expect(fileResponse.body.summary.data.reviewStatus).toBe("has_problem");
  });

  it("approves all ranges in local metadata without changing range files", async () => {
    fs.writeFileSync(
      path.join(preflopRangesPath, "3OD-EP", "second.json"),
      JSON.stringify({
        A: { raise: "AA", call: "" },
        B: { raise: "", call: "KK" }
      })
    );
    const app = createApp({ db, refreshService: service, preflopRangesPath });
    const firstFile = path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json");
    const before = fs.readFileSync(firstFile, "utf8");

    const response = await request(app).post("/api/preflop-ranges/approve-all");

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect(fs.readFileSync(firstFile, "utf8")).toBe(before);

    const metadata = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_status.json"), "utf8"));
    expect(metadata.ranges["3OD-EP/3OD-4.3 vs 3IA-4.2.json"]).toMatchObject({
      reviewStatus: "approved",
      runStatus: "idle"
    });
    expect(metadata.ranges["3OD-EP/second.json"]).toMatchObject({
      reviewStatus: "approved",
      runStatus: "idle"
    });
  });

  it("refreshes Hugging Face progress and derives solved run status from row count", async () => {
    const app = createApp({
      db,
      refreshService: service,
      preflopRangesPath,
      solverJobRepoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://huggingface.co/api/datasets/")) {
        return new Response(JSON.stringify({ id: "Tsumugii/3ia-4.2-3od-4.3" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        size: {
          dataset: {
            num_rows: 1755
          }
        }
      }), { status: 200 });
    }));

    await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", status: "approved" });

    const response = await request(app).post("/api/preflop-ranges/refresh-progress");

    expect(response.status).toBe(200);
    expect(response.body.checked).toBe(1);
    expect(response.body.failed).toBe(0);
    expect(response.body.tree[0].children[0]).toMatchObject({
      runStatus: "solved",
      datasetName: "3ia-4.2-3od-4.3",
      progress: {
        rows: 1755,
        totalRows: 1755,
        ratio: 1
      }
    });

    const progress = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_progress.json"), "utf8"));
    expect(progress.ranges["3OD-EP/3OD-4.3 vs 3IA-4.2.json"]).toMatchObject({
      datasetName: "3ia-4.2-3od-4.3",
      rows: 1755,
      ratio: 1
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://huggingface.co/api/datasets/Tsumugii/3ia-4.2-3od-4.3"
    );
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
      "https://datasets-server.huggingface.co/size?dataset=Tsumugii%2F3ia-4.2-3od-4.3"
    );
  });

  it("falls back to paginated solver artifacts when the Hugging Face size service is unavailable", async () => {
    const app = createApp({
      db,
      refreshService: service,
      preflopRangesPath,
      solverJobRepoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    const treeUrl = "https://huggingface.co/api/datasets/Tsumugii/3ia-4.2-3od-4.3/tree/main";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/tree/main")) {
        if (url.includes("cursor=page-2")) {
          return new Response(JSON.stringify([
            { path: "nested/Qh,Jd,Ts.json" },
            { path: "reports/upload.json" }
          ]), { status: 200 });
        }
        return new Response(JSON.stringify([
          { path: ".gitattributes" },
          { path: "AcAd3c.parquet" },
          { path: "2h3d4s.parquet" }
        ]), {
          status: 200,
          headers: {
            Link: `<${treeUrl}?recursive=1&limit=1000&cursor=page-2>; rel="next"`
          }
        });
      }
      if (url.startsWith("https://huggingface.co/api/datasets/")) {
        return new Response(JSON.stringify({ id: "Tsumugii/3ia-4.2-3od-4.3" }), { status: 200 });
      }
      if (url.startsWith("https://datasets-server.huggingface.co/size")) {
        return new Response("temporarily unavailable", {
          status: 503,
          statusText: "Service Temporarily Unavailable"
        });
      }
      return new Response("not found", { status: 404 });
    }));

    await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", status: "approved" });

    const response = await request(app).post("/api/preflop-ranges/refresh-progress");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      checked: 1,
      failed: 0,
      fileListingFallbacks: 1
    });
    expect(response.body.tree[0].children[0]).toMatchObject({
      datasetName: "3ia-4.2-3od-4.3",
      progress: {
        rows: 3,
        totalRows: 1755,
        ratio: 3 / 1755
      }
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).startsWith("https://datasets-server.huggingface.co/size")
    )).toHaveLength(1);
  });

  it("treats a redirected Hugging Face dataset name as an exact-match miss", async () => {
    const app = createApp({
      db,
      refreshService: service,
      preflopRangesPath,
      solverJobRepoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: "https://huggingface.co/api/datasets/Tsumugii/3ia-4.2-3od-4.3-backup" }
    })));

    await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", status: "approved" });

    const response = await request(app).post("/api/preflop-ranges/refresh-progress");

    expect(response.status).toBe(200);
    expect(response.body.checked).toBe(1);
    expect(response.body.failed).toBe(0);
    expect(response.body.tree[0].children[0]).toMatchObject({
      runStatus: "idle",
      datasetName: "3ia-4.2-3od-4.3",
      progress: {
        rows: 0,
        totalRows: 1755,
        ratio: 0
      }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a Hugging Face response whose dataset id does not match exactly", async () => {
    const app = createApp({
      db,
      refreshService: service,
      preflopRangesPath,
      solverJobRepoNamespace: "Tsumugii",
      hfToken: "hf_test_token"
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "Tsumugii/3ia-4.2-3od-4.3-backup"
    }), { status: 200 })));

    await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", status: "approved" });

    const response = await request(app).post("/api/preflop-ranges/refresh-progress");

    expect(response.status).toBe(200);
    expect(response.body.failed).toBe(0);
    expect(response.body.tree[0].children[0].progress).toMatchObject({ rows: 0, ratio: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads legacy .range files as .json", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    const response = await request(app)
      .post("/api/preflop-ranges/upload-many")
      .send({
        folder: "3OD-EP",
        files: [
          {
            filename: "legacy.range",
            relativePath: "legacy.range",
            content: JSON.stringify({
              status: "solved",
              A: { raise: "AA", call: "" },
              B: { raise: "", call: "" }
            })
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.saved[0]).toBe("3OD-EP/legacy.json");
    const savedPath = path.join(preflopRangesPath, "3OD-EP", "legacy.json");
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.existsSync(path.join(preflopRangesPath, "3OD-EP", "legacy.range"))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    expect(saved).not.toHaveProperty("learned");
    expect(saved).not.toHaveProperty("status");
    expect(saved).not.toHaveProperty("reviewStatus");
    expect(saved).not.toHaveProperty("runStatus");

    const metadata = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_status.json"), "utf8"));
    expect(metadata.ranges["3OD-EP/legacy.json"]).toMatchObject({
      reviewStatus: "approved",
      runStatus: "solved"
    });
  });

  it("preserves explicit OOP and IP assignments during upload", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    const response = await request(app)
      .post("/api/preflop-ranges/upload-many")
      .send({
        folder: "3OD-EP",
        files: [{
          filename: "SIA-30 vs SOD-28.json",
          relativePath: "SIA-30 vs SOD-28.json",
          content: JSON.stringify({
            player_names: { A: "HERO", B: "VILLIAN" },
            player_positions: { A: "OOP", B: "IP" },
            A: { raise: "", call: "AQs:0.250" },
            B: { raise: "AA", call: "" }
          })
        }]
      });

    expect(response.status).toBe(201);
    const savedPath = path.join(preflopRangesPath, "3OD-EP", "SIA-30 vs SOD-28.json");
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    expect(saved.player_positions).toEqual({ A: "OOP", B: "IP" });
  });

  it("renames folders and moves nested range metadata", async () => {
    fs.mkdirSync(path.join(preflopRangesPath, "3OD-EP", "Nested"), { recursive: true });
    fs.writeFileSync(
      path.join(preflopRangesPath, "3OD-EP", "Nested", "nested.json"),
      JSON.stringify({
        A: { raise: "AA", call: "" },
        B: { raise: "", call: "KK" }
      })
    );
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/Nested/nested.json", status: "approved" });

    const response = await request(app)
      .post("/api/preflop-ranges/rename")
      .send({ path: "3OD-EP/Nested", newName: "Renamed" });

    expect(response.status).toBe(200);
    expect(response.body.path).toBe("3OD-EP/Renamed");
    expect(fs.existsSync(path.join(preflopRangesPath, "3OD-EP", "Nested"))).toBe(false);
    expect(fs.existsSync(path.join(preflopRangesPath, "3OD-EP", "Renamed", "nested.json"))).toBe(true);

    const metadata = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_status.json"), "utf8"));
    expect(metadata.ranges["3OD-EP/Nested/nested.json"]).toBeUndefined();
    expect(metadata.ranges["3OD-EP/Renamed/nested.json"]).toMatchObject({
      reviewStatus: "approved",
      runStatus: "idle"
    });

    const listResponse = await request(app).get("/api/preflop-ranges");
    expect(listResponse.body.tree[0].children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "folder", name: "Renamed", path: "3OD-EP/Renamed" })
      ])
    );
  });

  it("deletes folders recursively and removes nested range metadata", async () => {
    fs.mkdirSync(path.join(preflopRangesPath, "3OD-EP", "Delete Me"), { recursive: true });
    fs.writeFileSync(
      path.join(preflopRangesPath, "3OD-EP", "Delete Me", "delete-me.json"),
      JSON.stringify({
        A: { raise: "AA", call: "" },
        B: { raise: "", call: "KK" }
      })
    );
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/Delete Me/delete-me.json", status: "approved" });

    const response = await request(app)
      .delete("/api/preflop-ranges/path")
      .query({ path: "3OD-EP/Delete Me" });

    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(preflopRangesPath, "3OD-EP", "Delete Me"))).toBe(false);

    const metadata = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, ".range_status.json"), "utf8"));
    expect(metadata.ranges["3OD-EP/Delete Me/delete-me.json"]).toBeUndefined();

    const listResponse = await request(app).get("/api/preflop-ranges");
    expect(JSON.stringify(listResponse.body.tree)).not.toContain("Delete Me");
  });
});
