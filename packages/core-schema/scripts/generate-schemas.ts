/**
 * Regenerates schemas/*.schema.json from the Zod schemas (the single source
 * of truth). Run: pnpm --filter @fleetos/core-schema generate
 *
 * CI never runs this script — instead the parity test asserts every
 * checked-in file matches fresh regeneration output, so a Zod edit without
 * regeneration fails the ordinary test run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildJsonSchemas, SCHEMA_REGISTRY } from "../src/json-schema.js";

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

mkdirSync(schemasDir, { recursive: true });
const built = buildJsonSchemas();
for (const entry of SCHEMA_REGISTRY) {
  const doc = built[entry.name];
  if (doc === undefined) {
    throw new Error(`registry entry ${entry.name} produced no JSON Schema document`);
  }
  const file = join(schemasDir, `${entry.name}.schema.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${file}\n`);
}
