import type { Robot } from "@fleetos/core-schema";

/**
 * Greenworks simulator fleet — synthetic devices behind a modeled
 * local-gateway cloud API. No record describes a real device; model ids carry
 * a `-sim` suffix. Both mowers are CN-produced, so per the 2026-07-28 FCC
 * Covered List action they model `waived-update-window` posture with the
 * firmware-update waiver expiry (>= 2029-01-01) tracked per device.
 */
export const GREENWORKS_ROBOTS: readonly Robot[] = [
  {
    schemaVersion: "1.0.0",
    robotId: "greenworks-mower-01",
    vendor: "greenworks",
    model: "optimz-5206-sim",
    firmwareVersion: "2.4.1-sim",
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
      fccStatus: "waived-update-window",
      firmwareUpdateEligibleUntil: "2029-06-30",
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "greenworks-cloud-sim",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "progressPct"],
      },
    },
  },
  {
    schemaVersion: "1.0.0",
    robotId: "greenworks-mower-02",
    vendor: "greenworks",
    model: "optimz-5206-sim",
    firmwareVersion: "2.4.1-sim",
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
    confidence: 0.88,
    compliance: {
      productionOrigin: "CN",
      fccStatus: "waived-update-window",
      firmwareUpdateEligibleUntil: "2029-06-30",
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "greenworks-cloud-sim",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "progressPct"],
      },
    },
  },
];
