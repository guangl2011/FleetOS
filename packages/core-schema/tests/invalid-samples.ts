import type { SchemaName } from "../src/json-schema.js";

/**
 * Invalid samples per published schema. Every sample must be rejected by the
 * Zod schema; non-zodOnly samples must ALSO be rejected by the published
 * JSON Schema file (Ajv) — that is the parity contract.
 *
 * `zodOnly: true` marks rules JSON Schema cannot express (cross-field
 * ordering): they are asserted against Zod only; JSON Schema parity does not
 * cover Zod-only invariants.
 */
export interface InvalidSample {
  readonly schemaName: SchemaName;
  readonly why: string;
  readonly sample: unknown;
  readonly zodOnly?: boolean;
}

const VALID_CAPABILITY = {
  taskTypes: ["mow"],
  maxSlopeDeg: 20,
  batteryWh: 7200,
  nominalPowerWhPerHour: 900,
  chargeHours: [1.5, 4],
  weatherTolerance: ["clear"],
  noGoZones: true,
  remoteResume: false,
} as const;

const VALID_COMPLIANCE = {
  productionOrigin: "CN",
  fccStatus: "authorized",
  firmwareUpdateEligibleUntil: null,
  dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
  dataFlow: {
    oemCloud: "greenworks-cloud-sim",
    traversedJurisdictions: ["US"],
    telemetryFieldAllowlist: ["batteryPct"],
  },
} as const;

export const INVALID_SAMPLES: readonly InvalidSample[] = [
  // robot
  {
    schemaName: "robot",
    why: "unknown keys are rejected (strict contract)",
    sample: {
      schemaVersion: "1.0.0",
      robotId: "robot-01",
      vendor: "greenworks",
      model: "optimz-5206-sim",
      firmwareVersion: "2.4.1",
      kind: "mower",
      capabilities: VALID_CAPABILITY,
      commands: ["PAUSE"],
      confidence: 0.9,
      compliance: VALID_COMPLIANCE,
      vendorSecret: "leak",
    },
  },
  {
    schemaName: "robot",
    why: "unknown robot kind",
    sample: {
      schemaVersion: "1.0.0",
      robotId: "robot-01",
      vendor: "greenworks",
      model: "optimz-5206-sim",
      firmwareVersion: "2.4.1",
      kind: "drone",
      capabilities: VALID_CAPABILITY,
      commands: ["PAUSE"],
      confidence: 0.9,
      compliance: VALID_COMPLIANCE,
    },
  },
  {
    schemaName: "robot",
    why: "confidence above 1",
    sample: {
      schemaVersion: "1.0.0",
      robotId: "robot-01",
      vendor: "greenworks",
      model: "optimz-5206-sim",
      firmwareVersion: "2.4.1",
      kind: "mower",
      capabilities: VALID_CAPABILITY,
      commands: ["PAUSE"],
      confidence: 1.5,
      compliance: VALID_COMPLIANCE,
    },
  },
  {
    schemaName: "robot",
    why: "empty command allow-list cannot be dispatched",
    sample: {
      schemaVersion: "1.0.0",
      robotId: "robot-01",
      vendor: "greenworks",
      model: "optimz-5206-sim",
      firmwareVersion: "2.4.1",
      kind: "mower",
      capabilities: VALID_CAPABILITY,
      commands: [],
      confidence: 0.9,
      compliance: VALID_COMPLIANCE,
    },
  },
  {
    schemaName: "robot",
    why: "missing compliance block — compliance by design is not optional",
    sample: {
      schemaVersion: "1.0.0",
      robotId: "robot-01",
      vendor: "greenworks",
      model: "optimz-5206-sim",
      firmwareVersion: "2.4.1",
      kind: "mower",
      capabilities: VALID_CAPABILITY,
      commands: ["PAUSE"],
      confidence: 0.9,
    },
  },
  {
    schemaName: "robot",
    why: "unsupported schema major",
    sample: {
      schemaVersion: "2.0.0",
      robotId: "robot-01",
      vendor: "greenworks",
      model: "optimz-5206-sim",
      firmwareVersion: "2.4.1",
      kind: "mower",
      capabilities: VALID_CAPABILITY,
      commands: ["PAUSE"],
      confidence: 0.9,
      compliance: VALID_COMPLIANCE,
    },
  },

  // robot-capability
  {
    schemaName: "robot-capability",
    why: "empty taskTypes can never be scheduled",
    sample: { ...VALID_CAPABILITY, taskTypes: [] },
  },
  {
    schemaName: "robot-capability",
    why: "slope beyond 90 degrees",
    sample: { ...VALID_CAPABILITY, maxSlopeDeg: 95 },
  },
  {
    schemaName: "robot-capability",
    why: "battery capacity must be positive",
    sample: { ...VALID_CAPABILITY, batteryWh: -7200 },
  },
  {
    schemaName: "robot-capability",
    why: "unknown weather tolerance",
    sample: { ...VALID_CAPABILITY, weatherTolerance: ["hail"] },
  },
  {
    schemaName: "robot-capability",
    why: "chargeHours ordered [typical, worst-case]",
    sample: { ...VALID_CAPABILITY, chargeHours: [4, 1.5] },
    zodOnly: true,
  },

  // compliance-block
  {
    schemaName: "compliance-block",
    why: "production origin must be an ISO 3166-1 alpha-2 code",
    sample: { ...VALID_COMPLIANCE, productionOrigin: "usa" },
  },
  {
    schemaName: "compliance-block",
    why: "unknown FCC status",
    sample: { ...VALID_COMPLIANCE, fccStatus: "pending" },
  },
  {
    schemaName: "compliance-block",
    why: "firmware-update window must be an ISO calendar date or null",
    sample: { ...VALID_COMPLIANCE, firmwareUpdateEligibleUntil: "2029-13-01" },
  },

  // data-flow-profile
  {
    schemaName: "data-flow-profile",
    why: "a telemetry flow always transits at least one jurisdiction",
    sample: {
      oemCloud: "navimow-cloud-sim",
      traversedJurisdictions: [],
      telemetryFieldAllowlist: ["batteryPct"],
    },
  },
  {
    schemaName: "data-flow-profile",
    why: "an empty telemetry field allowlist defeats data minimization",
    sample: {
      oemCloud: "navimow-cloud-sim",
      traversedJurisdictions: ["US"],
      telemetryFieldAllowlist: [],
    },
  },

  // fleet-task
  {
    schemaName: "fleet-task",
    why: "priority below the 1-100 range",
    sample: {
      schemaVersion: "1.0.0",
      taskId: "task-01",
      siteId: "site-park",
      requirements: { taskTypes: ["mow"] },
      window: { notBefore: "2026-11-02T08:00:00Z", notAfter: "2026-11-02T18:00:00Z" },
      priority: 0,
      status: "pending",
    },
  },
  {
    schemaName: "fleet-task",
    why: "priority must be an integer",
    sample: {
      schemaVersion: "1.0.0",
      taskId: "task-01",
      siteId: "site-park",
      requirements: { taskTypes: ["mow"] },
      window: { notBefore: "2026-11-02T08:00:00Z", notAfter: "2026-11-02T18:00:00Z" },
      priority: 50.5,
      status: "pending",
    },
  },
  {
    schemaName: "fleet-task",
    why: "unknown task status",
    sample: {
      schemaVersion: "1.0.0",
      taskId: "task-01",
      siteId: "site-park",
      requirements: { taskTypes: ["mow"] },
      window: { notBefore: "2026-11-02T08:00:00Z", notAfter: "2026-11-02T18:00:00Z" },
      priority: 50,
      status: "queued",
    },
  },
  {
    schemaName: "fleet-task",
    why: "window ends before it starts",
    sample: {
      schemaVersion: "1.0.0",
      taskId: "task-01",
      siteId: "site-park",
      requirements: { taskTypes: ["mow"] },
      window: { notBefore: "2026-11-02T18:00:00Z", notAfter: "2026-11-02T08:00:00Z" },
      priority: 50,
      status: "pending",
    },
    zodOnly: true,
  },

  // dispatch-plan
  {
    schemaName: "dispatch-plan",
    why: "projected on-time completion above 1",
    sample: {
      schemaVersion: "1.0.0",
      planId: "plan-01",
      createdAt: "2026-11-02T06:00:00Z",
      assignments: [],
      projected: { onTimeCompletion: 1.2, expectedInterventions: 0, minBatteryReservePct: 20 },
    },
  },
  {
    schemaName: "dispatch-plan",
    why: "negative expected interventions",
    sample: {
      schemaVersion: "1.0.0",
      planId: "plan-01",
      createdAt: "2026-11-02T06:00:00Z",
      assignments: [],
      projected: { onTimeCompletion: 0.9, expectedInterventions: -0.1, minBatteryReservePct: 20 },
    },
  },

  // schedule-entry
  {
    schemaName: "schedule-entry",
    why: "duration estimate must be positive",
    sample: {
      robotId: "robot-01",
      taskId: "task-01",
      startAt: "2026-11-02T08:30:00Z",
      estMinutes: -5,
      riskNotes: [],
    },
  },

  // telemetry-sample
  {
    schemaName: "telemetry-sample",
    why: "battery percentage above 100",
    sample: { robotId: "robot-01", ts: "2026-11-02T09:12:00Z", batteryPct: 101, charging: false },
  },
  {
    schemaName: "telemetry-sample",
    why: "latitude beyond ±90",
    sample: {
      robotId: "robot-01",
      ts: "2026-11-02T09:12:00Z",
      batteryPct: 50,
      charging: false,
      pose: { lat: 91, lon: 0 },
    },
  },

  // fault-event
  {
    schemaName: "fault-event",
    why: "unknown fault type outside the normalized taxonomy",
    sample: {
      faultId: "fault-01",
      robotId: "robot-01",
      ts: "2026-11-02T09:45:00Z",
      type: "CRASH",
      severity: "warning",
      message: "unmapped vendor code",
    },
  },

  // intervention
  {
    schemaName: "intervention",
    why: "teleoperation is not part of the remote surface (non-goal guardrail)",
    sample: {
      interventionId: "intv-01",
      ts: "2026-11-02T09:52:00Z",
      robotId: "robot-01",
      kind: "teleoperate",
      operatorId: "operator-dana",
      reason: "attempted remote drive",
    },
  },

  // audit-event
  {
    schemaName: "audit-event",
    why: "append positions start at 1",
    sample: {
      seq: 0,
      at: "2026-11-02T09:52:01Z",
      actorType: "operator",
      actorId: "operator-dana",
      action: "INTERVENTION_RESUME",
      subjectType: "robot",
      subjectId: "robot-01",
    },
  },

  // constraint-pack
  {
    schemaName: "constraint-pack",
    why: "unknown constraint source",
    sample: {
      schemaVersion: "1.0.0",
      packId: "pack-01",
      source: "whim",
      appliesTo: {},
      hard: [],
      soft: [],
      costTerms: [],
      provenance: { origin: "test", humanApproved: true },
    },
  },
  {
    schemaName: "constraint-pack",
    why: "hard constraint lists must be non-empty when present",
    sample: {
      schemaVersion: "1.0.0",
      packId: "pack-01",
      source: "site-rules",
      appliesTo: {},
      hard: [
        { rule: "time-window", constraintId: "hc-1", description: "night", forbiddenWindows: [] },
      ],
      soft: [],
      costTerms: [],
      provenance: { origin: "test", humanApproved: true },
    },
  },
  {
    schemaName: "constraint-pack",
    why: "site selectors select at least one site",
    sample: {
      schemaVersion: "1.0.0",
      packId: "pack-01",
      source: "site-rules",
      appliesTo: { siteIds: [] },
      hard: [],
      soft: [],
      costTerms: [],
      provenance: { origin: "test", humanApproved: true },
    },
  },
  {
    schemaName: "constraint-pack",
    why: "unknown hard-constraint rule",
    sample: {
      schemaVersion: "1.0.0",
      packId: "pack-01",
      source: "regulation",
      appliesTo: {},
      hard: [{ rule: "vibes", constraintId: "hc-1", description: "no" }],
      soft: [],
      costTerms: [],
      provenance: { origin: "test", humanApproved: true },
    },
  },

  // site-selector
  {
    schemaName: "site-selector",
    why: "a selector that names zero sites selects nothing",
    sample: { siteIds: [] },
  },
  {
    schemaName: "site-selector",
    why: "site ids follow the entity-id pattern",
    sample: { siteIds: ["park site"] },
  },
  {
    schemaName: "site-selector",
    why: "unknown robot kind cannot be targeted",
    sample: { robotKinds: ["drone"] },
  },
  {
    schemaName: "site-selector",
    why: "unknown selector dimensions are rejected",
    sample: { regions: ["eu-west"] },
  },
];
