import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("updates learned status and writes it to disk", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    const response = await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", learned: true });

    expect(response.status).toBe(200);
    expect(response.body.summary.data.learned).toBe(true);
    expect(response.body.summary.data.status).toBe("approved");
    const saved = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json"), "utf8"));
    expect(saved.learned).toBe(true);
    expect(saved.status).toBe("approved");
  });

  it("updates review status and writes it to disk", async () => {
    const app = createApp({ db, refreshService: service, preflopRangesPath });

    const response = await request(app)
      .post("/api/preflop-ranges/status")
      .send({ path: "3OD-EP/3OD-4.3 vs 3IA-4.2.json", status: "has_problem" });

    expect(response.status).toBe(200);
    expect(response.body.summary.data.status).toBe("has_problem");
    expect(response.body.summary.data.learned).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(preflopRangesPath, "3OD-EP", "3OD-4.3 vs 3IA-4.2.json"), "utf8"));
    expect(saved.status).toBe("has_problem");
    expect(saved.learned).toBe(false);
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
              A: { raise: "AA", call: "" },
              B: { raise: "", call: "" }
            })
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.saved[0]).toBe("3OD-EP/legacy.json");
    expect(fs.existsSync(path.join(preflopRangesPath, "3OD-EP", "legacy.json"))).toBe(true);
    expect(fs.existsSync(path.join(preflopRangesPath, "3OD-EP", "legacy.range"))).toBe(false);
  });
});
