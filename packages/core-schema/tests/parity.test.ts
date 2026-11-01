import type { SchemaObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildJsonSchemas, SCHEMA_REGISTRY, type SchemaName } from "../src/json-schema.js";
import { isRejected } from "./helpers.js";
import { INVALID_SAMPLES } from "./invalid-samples.js";
import { fixturesFor } from "./valid-fixtures.js";

// ajv-formats ships a CJS module with an ESM-style declaration; under
// nodenext the default binding's type resolves to the module namespace,
// so pin the call signature we rely on. (Same shim as IntentVisible.)
type AddFormats = (ajv: Ajv2020) => void;
const addFormats = addFormatsDefault as unknown as AddFormats;

function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function loadSchema(name: SchemaName): SchemaObject {
  const raw = readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8");
  return JSON.parse(raw) as SchemaObject;
}

/**
 * Ajv/Zod parity: each checked-in JSON Schema document (published for non-TS
 * consumers) and its Zod source must accept/reject the same samples. Zod-only
 * invariants (cross-field ordering) are excluded — they are asserted against
 * Zod in the round-trip suite, mirroring the IntentVisible pattern.
 */
describe("published JSON Schemas (Ajv draft 2020-12)", () => {
  const ajv = makeAjv();
  const built = buildJsonSchemas();

  it("covers every registry entry with a checked-in file", () => {
    for (const entry of SCHEMA_REGISTRY) {
      expect(() => loadSchema(entry.name as SchemaName), entry.name).not.toThrow();
    }
  });

  describe.each(SCHEMA_REGISTRY)("parity: $name", ({ name, schema }) => {
    const validate = ajv.compile(loadSchema(name as SchemaName));

    it("accepts every valid fixture", () => {
      for (const fixture of fixturesFor(name as SchemaName)) {
        const result = validate(fixture);
        if (!result) {
          throw new Error(
            `${name}: Ajv rejected a valid fixture: ${JSON.stringify(validate.errors)}`,
          );
        }
        expect(result).toBe(true);
      }
    });

    it("agrees with Zod on every invalid sample", () => {
      const samples = INVALID_SAMPLES.filter((s) => s.schemaName === name && s.zodOnly !== true);
      expect(samples.length, `parity coverage: invalid samples for ${name}`).toBeGreaterThan(0);
      for (const { why, sample } of samples) {
        expect(validate(sample), `Ajv: ${why}`).toBe(false);
        expect(isRejected(schema, sample), `Zod: ${why}`).toBe(true);
      }
    });

    it("is fresh: the checked-in file matches regeneration output", () => {
      expect(loadSchema(name as SchemaName)).toEqual(built[name as SchemaName]);
    });
  });
});
