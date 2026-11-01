import { describe, expect, it } from "vitest";

import {
  COMMAND_PERMISSIONS,
  ROBOT_KINDS,
  RobotCapabilitySchema,
  TASK_TYPES,
  WEATHER_CONDITIONS,
} from "../src/capability.js";
import { FAULT_TYPES } from "../src/fault.js";
import { FCC_STATUSES } from "../src/compliance.js";
import {
  CONSTRAINT_SOURCES,
  HardConstraintSchema,
  type HardConstraint,
} from "../src/constraints.js";
import { exampleConstraintPack, exampleFleetTask, exampleRobotMower } from "../src/fixtures.js";
import { SCHEMA_REGISTRY, type SchemaName } from "../src/json-schema.js";
import {
  ConfidenceSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  TimeOfDaySchema,
} from "../src/primitives.js";
import { FleetTaskSchema, TASK_STATUSES } from "../src/task.js";
import {
  isSchemaVersionCompatible,
  parseSchemaVersion,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_MAJOR,
} from "../src/version.js";
import { ensureParsed, isRejected, issuePaths } from "./helpers.js";
import { INVALID_SAMPLES } from "./invalid-samples.js";
import { fixturesFor } from "./valid-fixtures.js";

/**
 * Round-trip unit tests: every published schema parses its valid fixtures,
 * survives JSON serialize → parse unchanged, and rejects its invalid
 * samples (including the Zod-only invariants JSON Schema cannot express).
 */

describe.each(SCHEMA_REGISTRY)("round-trip: $name", ({ name, schema }) => {
  it("parses every valid fixture", () => {
    for (const fixture of fixturesFor(name as SchemaName)) {
      expect(ensureParsed(schema, fixture), `${name} fixture`).toBeDefined();
    }
  });

  it("survives JSON serialize → parse unchanged", () => {
    for (const fixture of fixturesFor(name as SchemaName)) {
      const parsed = ensureParsed(schema, fixture);
      const serialized = JSON.stringify(parsed);
      const reparsed = ensureParsed(schema, JSON.parse(serialized));
      expect(reparsed).toEqual(parsed);
    }
  });

  it("rejects its invalid samples", () => {
    const samples = INVALID_SAMPLES.filter((s) => s.schemaName === name);
    expect(samples.length, `coverage: invalid samples for ${name}`).toBeGreaterThan(0);
    for (const { why, sample } of samples) {
      expect(isRejected(schema, sample), why).toBe(true);
    }
  });
});

describe("Zod-only invariants (JSON Schema cannot express them)", () => {
  it("rejects reversed chargeHours with the ordering issue path", () => {
    const reversed = {
      ...exampleRobotMower.capabilities,
      chargeHours: [4, 1.5] as [number, number],
    };
    expect(issuePaths(RobotCapabilitySchema, reversed)).toContain("chargeHours");
  });

  it("rejects a task window that ends before it starts", () => {
    const reversed = {
      ...exampleFleetTask,
      window: { notBefore: "2026-11-02T18:00:00Z", notAfter: "2026-11-02T08:00:00Z" },
    };
    expect(issuePaths(FleetTaskSchema, reversed)).toContain("window");
  });

  it("accepts a hard constraint whose noise window wraps midnight", () => {
    const nightWrap: HardConstraint = {
      rule: "time-window",
      constraintId: "hc-night",
      description: "no mowing 22:00-07:00",
      forbiddenWindows: [{ start: "22:00", end: "07:00" }],
    };
    expect(isRejected(HardConstraintSchema, nightWrap)).toBe(false);
  });
});

describe("version discipline", () => {
  it("pins the fixture records to the supported major", () => {
    const parsed = parseSchemaVersion(exampleRobotMower.schemaVersion);
    expect(parsed?.major).toBe(SUPPORTED_SCHEMA_MAJOR);
    expect(exampleConstraintPack.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("accepts compatible and rejects incompatible schema versions", () => {
    expect(isSchemaVersionCompatible("1.0.0")).toBe(true);
    expect(isSchemaVersionCompatible("1.2.3")).toBe(true);
    expect(isSchemaVersionCompatible("2.0.0")).toBe(false);
    expect(isSchemaVersionCompatible("1.0")).toBe(false);
    expect(isSchemaVersionCompatible("not-a-version")).toBe(false);
  });
});

describe("primitive contracts", () => {
  it("accepts RFC 3339 timestamps with Z or an explicit offset", () => {
    expect(IsoDateTimeSchema.safeParse("2026-11-02T08:00:00Z").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-11-02T00:00:00-08:00").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-11-02T08:00Z").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse("2026-11-02 08:00:00Z").success).toBe(false);
  });

  it("bounds confidence to [0, 1] and enforces id/time-of-day patterns", () => {
    expect(ConfidenceSchema.safeParse(0).success).toBe(true);
    expect(ConfidenceSchema.safeParse(1).success).toBe(true);
    expect(ConfidenceSchema.safeParse(-0.01).success).toBe(false);
    expect(ConfidenceSchema.safeParse(1.01).success).toBe(false);
    expect(EntityIdSchema.safeParse("robot-mower-01").success).toBe(true);
    expect(EntityIdSchema.safeParse("robot mower 01").success).toBe(false);
    expect(TimeOfDaySchema.safeParse("22:00").success).toBe(true);
    expect(TimeOfDaySchema.safeParse("24:00").success).toBe(false);
  });
});

describe("enum vocabularies trace to the spec", () => {
  it("keeps the normalized taxonomies exact", () => {
    expect([...TASK_TYPES]).toEqual(["mow", "scrub", "inspect"]);
    expect([...ROBOT_KINDS]).toEqual(["mower", "scrubber", "inspection-rover"]);
    expect([...WEATHER_CONDITIONS]).toEqual(["clear", "light-rain", "wet-grass"]);
    expect([...COMMAND_PERMISSIONS]).toEqual([
      "START_TASK",
      "PAUSE",
      "RESUME",
      "DOCK_CHARGE",
      "RETURN_HOME",
      "SET_NO_GO_ZONE",
      "ABORT",
    ]);
    expect([...FAULT_TYPES]).toEqual([
      "BATTERY",
      "STUCK",
      "SENSOR_DEGRADED",
      "COMMS_LOST",
      "WEATHER_HOLD",
      "MAINTENANCE_DUE",
    ]);
    expect([...TASK_STATUSES]).toEqual([
      "pending",
      "scheduled",
      "in-progress",
      "held",
      "completed",
      "cancelled",
    ]);
    expect([...FCC_STATUSES]).toEqual(["authorized", "waived-update-window", "unauthorized"]);
    expect([...CONSTRAINT_SOURCES]).toEqual([
      "tariff",
      "weather",
      "site-rules",
      "sla",
      "regulation",
    ]);
  });
});
