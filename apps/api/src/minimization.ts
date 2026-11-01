import { TelemetrySampleSchema } from "@fleetos/core-schema";
import type { Robot, TelemetrySample } from "@fleetos/core-schema";

/**
 * Telemetry-field minimization (spec data-compliance chapter): the platform
 * sends and stores the minimum field set each adapter actually consumes.
 * The per-robot allowlist lives in the robot's compliance block
 * (`compliance.dataFlow.telemetryFieldAllowlist`), named in the vendor's
 * vocabulary. Minimization runs at the ingestion boundary — before
 * persistence and before the world model sees the sample — so an unapproved
 * field is never stored, never forwarded, and never even parsed into the
 * shadow.
 *
 * Two behaviors, both enforced here:
 * - optional fields not approved (pose, progressPct) → dropped: reported to
 *   the caller, counted per robot, never persisted;
 * - required fields the allowlist does not approve → the ingest is rejected
 *   outright. Storing a required field would violate minimization; dropping
 *   it would violate the sample schema — rejection is the only honest exit.
 */

/** Failure modes of minimization; the route maps both to 422. */
export type MinimizationErrorCode = "TELEMETRY_FIELD_FORBIDDEN" | "TELEMETRY_INVALID";

export class MinimizationError extends Error {
  readonly code: MinimizationErrorCode;
  readonly fields: readonly string[];

  constructor(code: MinimizationErrorCode, message: string, fields: readonly string[]) {
    super(message);
    this.name = "MinimizationError";
    this.code = code;
    this.fields = fields;
  }
}

/**
 * Vendor allowlist names → the normalized TelemetrySample field they feed.
 * The adapter normalizes vendor payloads into core-schema samples, so
 * minimization enforces the allowlist over the normalized field each vendor
 * name becomes. Unknown vendor names (fields the adapter normalizes away
 * entirely) map to nothing and are ignored.
 */
const VENDOR_FIELD_ALIASES: Readonly<Record<string, string>> = {
  batteryPct: "batteryPct",
  charging: "charging",
  "pose.lat": "pose",
  "pose.lon": "pose",
  progressPct: "progressPct",
  cleanProgressPct: "progressPct",
  activity: "progressPct",
};

/** Sample fields every ingest must carry (TelemetrySampleSchema requires them). */
export const REQUIRED_SAMPLE_FIELDS: readonly string[] = ["robotId", "ts", "batteryPct", "charging"];

/** The two schema-required data fields whose approval the allowlist must grant. */
const REQUIRED_APPROVED_FIELDS: readonly string[] = ["batteryPct", "charging"];

const OPTIONAL_SAMPLE_FIELDS: readonly string[] = ["pose", "progressPct"];

/** Normalized optional sample fields this robot's allowlist approves. */
export function approvedOptionalFields(robot: Robot): ReadonlySet<string> {
  const approved = new Set<string>();
  for (const vendorName of robot.compliance.dataFlow.telemetryFieldAllowlist) {
    const normalized = VENDOR_FIELD_ALIASES[vendorName];
    if (normalized === undefined) {
      continue; // vendor-only field with no normalized counterpart
    }
    approved.add(normalized);
  }
  return approved;
}

export interface MinimizationResult {
  readonly sample: TelemetrySample;
  /** Field names removed from the payload before persistence — the compliance evidence. */
  readonly droppedFields: readonly string[];
}

/**
 * Strips unapproved fields from one raw ingest payload and validates what
 * remains against the core-schema sample. Pure: no store, no clock.
 */
export function minimizeTelemetrySample(raw: Record<string, unknown>, robot: Robot): MinimizationResult {
  const approved = approvedOptionalFields(robot);
  const dropped: string[] = [];
  const candidate: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (REQUIRED_SAMPLE_FIELDS.includes(key)) {
      candidate[key] = value;
      continue;
    }
    if (OPTIONAL_SAMPLE_FIELDS.includes(key) && approved.has(key)) {
      candidate[key] = value;
      continue;
    }
    dropped.push(key); // unapproved optional field, or a key no schema knows
  }

  for (const field of REQUIRED_SAMPLE_FIELDS) {
    if (!(field in candidate)) {
      throw new MinimizationError(
        "TELEMETRY_INVALID",
        `telemetry sample for robot "${robot.robotId}" is missing required field "${field}"`,
        [field],
      );
    }
  }

  // A required field the data-flow allowlist does not approve cannot be
  // stored (minimization) and cannot be dropped (schema) — reject the ingest.
  const unapprovedRequired = REQUIRED_APPROVED_FIELDS.filter((field) => !approved.has(field));
  if (unapprovedRequired.length > 0) {
    throw new MinimizationError(
      "TELEMETRY_FIELD_FORBIDDEN",
      `robot "${robot.robotId}" allowlist does not approve required telemetry field(s): ${unapprovedRequired.join(", ")} — ingest rejected`,
      unapprovedRequired,
    );
  }

  const parsed = TelemetrySampleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MinimizationError(
      "TELEMETRY_INVALID",
      `minimized telemetry sample for robot "${robot.robotId}" does not match the core schema: ${parsed.error.message}`,
      [],
    );
  }
  return { sample: parsed.data, droppedFields: dropped };
}
