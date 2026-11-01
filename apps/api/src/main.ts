import { buildApp } from "./app.js";
import { parseRegions } from "./config.js";

const host = process.env.FLEETOS_API_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.FLEETOS_API_PORT ?? "8737", 10);
if (Number.isNaN(port) || port <= 0 || port > 65535) {
  console.error(`FLEETOS_API_PORT must be a valid TCP port, got "${process.env.FLEETOS_API_PORT ?? ""}"`);
  process.exit(1);
}

const dataDir = process.env.FLEETOS_DATA_DIR;
if (dataDir === undefined || dataDir.length === 0) {
  console.error("FLEETOS_DATA_DIR is required — set it to the deployment's SQLite directory");
  process.exit(1);
}

const api = await buildApp({
  dataDir,
  residency: {
    allowedRegions: process.env.FLEETOS_REGIONS === undefined ? [] : parseRegions(process.env.FLEETOS_REGIONS),
  },
});

await api.app.listen({ host, port });
console.log(`fleetos-api listening on http://${host}:${port} (regions: ${api.options.residency.allowedRegions.join(", ")})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void api.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("error during shutdown", error);
        process.exit(1);
      },
    );
  });
}
