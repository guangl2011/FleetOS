import type { Robot } from "@fleetos/core-schema";

/**
 * Navimow (九号) simulator fleet — synthetic devices behind a modeled
 * cloud-to-cloud REST API shape (per the spec's evidence table: Segway-Ninebot
 * style OEM clouds expose command/telemetry REST surfaces with GNSS/RTK
 * positioning). No record describes a real device.
 *
 * CN place of production with an OEM cloud transit through a second
 * jurisdiction: the compliance block models `waived-update-window` posture
 * (FCC Covered List action, 2026-07-28) and a cross-border data-flow profile
 * that the console surfaces, never hides.
 */
export const NAVIMOW_ROBOTS: readonly Robot[] = [
  {
    schemaVersion: "1.0.0",
    robotId: "navimow-mower-01",
    vendor: "navimow",
    model: "navimow-sim-m2",
    firmwareVersion: "3.1.0-sim",
    kind: "mower",
    capabilities: {
      taskTypes: ["mow"],
      maxSlopeDeg: 25,
      batteryWh: 8800,
      nominalPowerWhPerHour: 1000,
      chargeHours: [2, 4.5],
      weatherTolerance: ["clear", "light-rain"],
      noGoZones: true,
      remoteResume: true,
    },
    commands: [
      "START_TASK",
      "PAUSE",
      "RESUME",
      "DOCK_CHARGE",
      "RETURN_HOME",
      "SET_NO_GO_ZONE",
      "ABORT",
    ],
    confidence: 0.93,
    compliance: {
      productionOrigin: "CN",
      fccStatus: "waived-update-window",
      firmwareUpdateEligibleUntil: "2029-06-30",
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: true },
      dataFlow: {
        oemCloud: "navimow-openapi-sim",
        traversedJurisdictions: ["US", "CN"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "progressPct"],
      },
    },
  },
  {
    schemaVersion: "1.0.0",
    robotId: "navimow-mower-02",
    vendor: "navimow",
    model: "navimow-sim-m2",
    firmwareVersion: "3.1.0-sim",
    kind: "mower",
    capabilities: {
      taskTypes: ["mow"],
      maxSlopeDeg: 25,
      batteryWh: 8800,
      nominalPowerWhPerHour: 1000,
      chargeHours: [2, 4.5],
      weatherTolerance: ["clear", "light-rain"],
      noGoZones: true,
      remoteResume: true,
    },
    commands: [
      "START_TASK",
      "PAUSE",
      "RESUME",
      "DOCK_CHARGE",
      "RETURN_HOME",
      "SET_NO_GO_ZONE",
      "ABORT",
    ],
    confidence: 0.9,
    compliance: {
      productionOrigin: "CN",
      fccStatus: "waived-update-window",
      firmwareUpdateEligibleUntil: "2029-06-30",
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: true },
      dataFlow: {
        oemCloud: "navimow-openapi-sim",
        traversedJurisdictions: ["US", "CN"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "progressPct"],
      },
    },
  },
  {
    schemaVersion: "1.0.0",
    robotId: "navimow-mower-03",
    vendor: "navimow",
    model: "navimow-sim-i1",
    firmwareVersion: "2.8.4-sim",
    kind: "mower",
    capabilities: {
      taskTypes: ["mow"],
      maxSlopeDeg: 22,
      batteryWh: 7500,
      nominalPowerWhPerHour: 950,
      chargeHours: [2, 4.5],
      weatherTolerance: ["clear", "light-rain"],
      noGoZones: false,
      remoteResume: true,
    },
    // Older i-series line: no cloud-side virtual-boundary support, so
    // SET_NO_GO_ZONE is absent — this is the fixture's gating negative case.
    commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "RETURN_HOME", "ABORT"],
    confidence: 0.9,
    compliance: {
      productionOrigin: "CN",
      fccStatus: "waived-update-window",
      firmwareUpdateEligibleUntil: "2029-06-30",
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: true },
      dataFlow: {
        oemCloud: "navimow-openapi-sim",
        traversedJurisdictions: ["US", "CN"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "pose.lat", "pose.lon", "progressPct"],
      },
    },
  },
];
