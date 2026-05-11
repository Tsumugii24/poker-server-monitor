import path from "node:path";
import express from "express";
import { createApp } from "./api";
import { loadRuntimeConfig, loadServerInventory } from "./config";
import { MonitorDatabase } from "./db";
import { RefreshService } from "./refreshService";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const servers = loadServerInventory(config.inventoryPath);
  const db = await MonitorDatabase.open(config.databasePath);
  db.syncServers(servers);

  const refreshService = new RefreshService({
    db,
    servers,
    intervalMs: config.refreshIntervalMs,
    credentials: config.ssh
  });
  refreshService.startScheduler();

  const app = createApp({ db, refreshService });
  const clientDist = path.resolve("dist/client");
  app.use(express.static(clientDist));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientDist, "index.html"));
  });

  app.listen(config.port, "127.0.0.1", () => {
    console.log(`Server monitor listening on http://127.0.0.1:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
