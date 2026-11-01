import type { Robot } from "@fleetos/core-schema";

/**
 * Husqvarna simulator fleet — synthetic devices behind a modeled Open API
 * shape (per the spec's evidence table: Husqvarna's Open API exposes
 * commercial-mower fleet integration to third-party platforms; no record
 * describes a real device or token).
 *
 * Modeled positioning (spec evidence, founder-confirmed 2026-11-01): the
 * vendor is highly open in commercial/professional segments — its robots are
 * planner-integrated (work zones live in the vendor planner, not set by
 * FleetOS), so SET_NO_GO_ZONE is NOT in the command allow-list.
 *
 * SE place of production with an authorized FCC posture: the compliance block
 * models the contrast case against the CN-origin vendors (no waived-update
 * window, domestic-only data flow).
 */
export const HUSQVARNA_ROBOTS: readonly Robot[] = [
  {
    schemaVersion: "1.0.0",
    robotId: "husqvarna-mower-01",
    vendor: "husqvarna",
    model: "husqvarna-sim-c1",
    firmwareVersion: "8.2.1-sim",
    kind: "mower",
    capabilities: {
      taskTypes: ["mow"],
      maxSlopeDeg: 30,
      batteryWh: 8000,
      nominalPowerWhPerHour: 950,
      chargeHours: [1.5, 3.5],
      weatherTolerance: ["clear", "wet-grass"],
      noGoZones: false,
      remoteResume: true,
    },
    commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "RETURN_HOME", "ABORT"],
    confidence: 0.95,
    compliance: {
      productionOrigin: "SE",
      fccStatus: "authorized",
      firmwareUpdateEligibleUntil: null,
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "husqvarna-openapi-sim",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "activity"],
      },
    },
  },
  {
    schemaVersion: "1.0.0",
    robotId: "husqvarna-mower-02",
    vendor: "husqvarna",
    model: "husqvarna-sim-c1",
    firmwareVersion: "8.2.1-sim",
    kind: "mower",
    capabilities: {
      taskTypes: ["mow"],
      maxSlopeDeg: 30,
      batteryWh: 8000,
      nominalPowerWhPerHour: 950,
      chargeHours: [1.5, 3.5],
      weatherTolerance: ["clear", "wet-grass"],
      noGoZones: false,
      remoteResume: true,
    },
    commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "RETURN_HOME", "ABORT"],
    confidence: 0.94,
    compliance: {
      productionOrigin: "SE",
      fccStatus: "authorized",
      firmwareUpdateEligibleUntil: null,
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "husqvarna-openapi-sim",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "activity"],
      },
    },
  },
];
