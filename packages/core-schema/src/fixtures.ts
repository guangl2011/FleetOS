import type { AuditEvent } from "./audit.js";
import type { Robot } from "./robot.js";
import type { ExternalConstraintPack } from "./constraints.js";
import type { DispatchPlan } from "./plan.js";
import type { FleetTask } from "./task.js";
import type { FaultEvent } from "./fault.js";
import type { Intervention } from "./intervention.js";
import type { TelemetrySample } from "./telemetry.js";

/**
 * Canonical example records — valid instances of every published schema,
 * reused by the round-trip and parity tests and as reference data for
 * downstream packages. All values are synthetic; none describes a real device.
 */

export const exampleRobotMower: Robot = {
  schemaVersion: "1.0.0",
  robotId: "robot-mower-01",
  vendor: "greenworks",
  model: "optimz-5206-sim",
  firmwareVersion: "2.4.1",
  kind: "mower",
  capabilities: {
    taskTypes: ["mow"],
    maxSlopeDeg: 20,
    batteryWh: 7200,
    nominalPowerWhPerHour: 900,
    chargeHours: [1.5, 4],
    weatherTolerance: ["clear", "wet-grass"],
    noGoZones: true,
    remoteResume: false,
  },
  commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "RETURN_HOME", "ABORT"],
  confidence: 0.95,
  compliance: {
    productionOrigin: "CN",
    fccStatus: "authorized",
    firmwareUpdateEligibleUntil: null,
    dataResidency: {
      telemetryRegion: "us-west-2",
      allowCrossBorderTelemetry: false,
    },
    dataFlow: {
      oemCloud: "greenworks-cloud-sim",
      traversedJurisdictions: ["US"],
      telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "progressPct"],
    },
  },
};

export const exampleRobotScrubber: Robot = {
  schemaVersion: "1.0.0",
  robotId: "robot-scrubber-01",
  vendor: "scrubbersim",
  model: "walkway-s20-sim",
  firmwareVersion: "0.9.3",
  kind: "scrubber",
  capabilities: {
    taskTypes: ["scrub"],
    maxSlopeDeg: 8,
    batteryWh: 3600,
    nominalPowerWhPerHour: 600,
    chargeHours: [2, 5],
    weatherTolerance: ["clear"],
    noGoZones: true,
    remoteResume: true,
  },
  commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "ABORT"],
  confidence: 0.9,
  compliance: {
    productionOrigin: "US",
    fccStatus: "authorized",
    firmwareUpdateEligibleUntil: null,
    dataResidency: {
      telemetryRegion: "us-west-2",
      allowCrossBorderTelemetry: false,
    },
    dataFlow: {
      oemCloud: "scrubbersim-local",
      traversedJurisdictions: ["US"],
      telemetryFieldAllowlist: ["batteryPct", "charging", "progressPct"],
    },
  },
};

export const exampleFleetTask: FleetTask = {
  schemaVersion: "1.0.0",
  taskId: "task-2026-11-02-001",
  siteId: "site-downtown-park",
  requirements: { taskTypes: ["mow"] },
  window: {
    notBefore: "2026-11-02T08:00:00Z",
    notAfter: "2026-11-02T18:00:00Z",
  },
  priority: 50,
  status: "pending",
};

export const exampleDispatchPlan: DispatchPlan = {
  schemaVersion: "1.0.0",
  planId: "plan-2026-11-02-0600",
  createdAt: "2026-11-02T06:00:00Z",
  assignments: [
    {
      robotId: "robot-mower-01",
      taskId: "task-2026-11-02-001",
      startAt: "2026-11-02T08:30:00Z",
      estMinutes: 145,
      riskNotes: ["battery reserve projected 22% at return-to-dock"],
    },
  ],
  projected: {
    onTimeCompletion: 0.92,
    expectedInterventions: 0.3,
    minBatteryReservePct: 22,
  },
};

export const exampleTelemetrySample: TelemetrySample = {
  robotId: "robot-mower-01",
  ts: "2026-11-02T09:12:00Z",
  batteryPct: 83.5,
  charging: false,
  pose: { lat: 47.6062, lon: -122.3321 },
  progressPct: 42,
};

export const exampleFaultEvent: FaultEvent = {
  faultId: "fault-2026-11-02-0007",
  robotId: "robot-mower-01",
  ts: "2026-11-02T09:45:00Z",
  type: "STUCK",
  severity: "warning",
  message: "drive stalled at zone 7 boundary; retry exceeded",
  taskId: "task-2026-11-02-001",
  detail: { zone: "7", retries: "3" },
};

export const exampleIntervention: Intervention = {
  interventionId: "intv-2026-11-02-0002",
  ts: "2026-11-02T09:52:00Z",
  robotId: "robot-mower-01",
  taskId: "task-2026-11-02-001",
  kind: "resume",
  operatorId: "operator-dana",
  reason: "cleared obstacle at zone 7 and approved resume",
  planId: "plan-2026-11-02-0600",
};

export const exampleAuditEvent: AuditEvent = {
  seq: 42,
  at: "2026-11-02T09:52:01Z",
  actorType: "operator",
  actorId: "operator-dana",
  action: "INTERVENTION_RESUME",
  subjectType: "robot",
  subjectId: "robot-mower-01",
  planId: "plan-2026-11-02-0600",
  detail: { interventionId: "intv-2026-11-02-0002" },
};

export const exampleConstraintPack: ExternalConstraintPack = {
  schemaVersion: "1.0.0",
  packId: "pack-tariff-bellevue-2026q4",
  source: "tariff",
  appliesTo: { siteIds: ["site-downtown-park"], robotKinds: ["mower"] },
  hard: [
    {
      rule: "time-window",
      constraintId: "hc-noise-ordinance-night",
      description: "municipal noise ordinance: no mowing 22:00-07:00",
      forbiddenWindows: [{ start: "22:00", end: "07:00" }],
    },
    {
      rule: "weather-cutoff",
      constraintId: "hc-weather-no-mow-in-rain",
      description: "no mowing during light rain or on wet grass",
      forbiddenConditions: ["light-rain", "wet-grass"],
    },
  ],
  soft: [
    {
      constraintId: "sc-demand-charge-aversion",
      description: "avoid aggregate charging during demand-charge peak",
      weight: 0.7,
    },
  ],
  costTerms: [
    {
      curveId: "curve-pse-2026q4",
      currency: "USD",
      points: [
        { at: "2026-11-02T00:00:00-08:00", pricePerKwh: 0.09 },
        { at: "2026-11-02T16:00:00-08:00", pricePerKwh: 0.28 },
        { at: "2026-11-02T21:00:00-08:00", pricePerKwh: 0.11 },
      ],
    },
  ],
  provenance: {
    origin: "utility tariff sheet + city ordinance (example)",
    humanApproved: true,
    extractedBy: "human",
  },
};
