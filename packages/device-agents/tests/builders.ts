import type { ExternalConstraintPack, FaultEvent, GeoPoint, Robot } from "@fleetos/core-schema";
import type { AssignedEnvelope } from "@fleetos/scheduler";
import type { DigitalShadowSlice } from "@fleetos/world-model";

/** Fixed instants — no wall clock anywhere (repo determinism convention). */
export const T0 = "2026-11-02T08:00:00.000Z";
export const T0_PLUS_5M = "2026-11-02T08:05:00.000Z";
export const T0_PLUS_10M = "2026-11-02T08:10:00.000Z";
export const T0_PLUS_11M = "2026-11-02T08:11:00.000Z";
export const T0_MINUS_5M = "2026-11-02T07:55:00.000Z";

export function mowerRobot(overrides: Partial<Robot> = {}): Robot {
  const base: Robot = {
    schemaVersion: "1.0.0",
    robotId: "robot-mower-01",
    vendor: "greenworks",
    model: "Optimus Z 60V",
    firmwareVersion: "2.4.1",
    kind: "mower",
    capabilities: {
      taskTypes: ["mow"],
      maxSlopeDeg: 15,
      batteryWh: 1440,
      nominalPowerWhPerHour: 900,
      chargeHours: [1.5, 2.5],
      weatherTolerance: ["clear"],
      noGoZones: true,
      remoteResume: true,
    },
    commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "RETURN_HOME", "ABORT"],
    confidence: 0.97,
    compliance: {
      productionOrigin: "CN",
      fccStatus: "waived-update-window",
      firmwareUpdateEligibleUntil: "2029-01-01",
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "greenworks-cloud",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "pose.lat"],
      },
    },
  };
  return { ...base, ...overrides };
}

export function envelope(overrides: Partial<AssignedEnvelope> = {}): AssignedEnvelope {
  return {
    envelopeId: "env-robot-mower-01-task-mow-01",
    robotId: "robot-mower-01",
    taskId: "task-mow-01",
    siteId: "site-park-north",
    assignedStartAt: T0,
    assignedEndAt: "2026-11-02T10:00:00.000Z",
    minBatteryReservePct: 20,
    swappableTaskIds: ["task-mow-02"],
    shiftToleranceMinutes: 10,
    ...overrides,
  };
}

export function faultEvent(overrides: Partial<FaultEvent> = {}): FaultEvent {
  return {
    faultId: "fault-robot-mower-01-WEATHER-HOLD-1",
    robotId: "robot-mower-01",
    ts: T0,
    type: "WEATHER_HOLD",
    severity: "info",
    message: "weather hold: rain observed at site",
    ...overrides,
  };
}

const POSE: GeoPoint = { lat: 47.6, lon: -122.3 };

export function shadowSlice(overrides: Partial<DigitalShadowSlice> = {}): DigitalShadowSlice {
  return {
    robotId: "robot-mower-01",
    vendor: "greenworks",
    kind: "mower",
    state: "faulted",
    confidence: 0.9,
    batteryPct: 76,
    charging: false,
    pose: POSE,
    progressPct: null,
    currentTaskId: "task-mow-01",
    lastTelemetryAt: T0,
    dataAgeSeconds: 5,
    activeFault: faultEvent(),
    lastFault: faultEvent(),
    activeConstraintPacks: [],
    ...overrides,
  };
}

/** Night noise ordinance: mowing forbidden 22:00–07:00 local (UTC in tests). */
export function noisePack(): ExternalConstraintPack {
  return {
    schemaVersion: "1.0.0",
    packId: "pack-noise-test",
    source: "regulation",
    appliesTo: {},
    hard: [
      {
        rule: "time-window",
        constraintId: "noise-night",
        description: "night noise ordinance: no mowing 22:00-07:00",
        forbiddenWindows: [{ start: "22:00", end: "07:00" }],
      },
    ],
    soft: [],
    costTerms: [],
    provenance: { origin: "test city ordinance", humanApproved: true, extractedBy: "human" },
  };
}
