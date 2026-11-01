import type { Robot } from "@fleetos/core-schema";

/**
 * Scrubber simulator fleet — the next-category proof (spec D1): a
 * different robot kind with a different vendor surface (relay-style local
 * WiFi API), exercising the same RobotAdapter contract so the capability
 * ontology demonstrably generalizes beyond mowers. No record describes a
 * real device.
 *
 * Modeled vendor quirks (simulator only, not a claim about any real product):
 * - cleaning progress is reported only while cleaning (otherwise absent);
 * - localization pose exists but is suppressed entirely when sensor health
 *   degrades — a different normalization shape than the mower vendors'
 *   fix-keyed position fields;
 * - deck jams are detected and latched as vendor error codes;
 * - relay-style local WiFi keeps commands synchronous, no GNSS, no cloud
 *   transit (US-only data flow).
 */
export const SCRUBBER_ROBOTS: readonly Robot[] = [
  {
    schemaVersion: "1.0.0",
    robotId: "scrubber-01",
    vendor: "scrubbersim",
    model: "scrubber-sim-s40",
    firmwareVersion: "1.4.0-sim",
    kind: "scrubber",
    capabilities: {
      taskTypes: ["scrub"],
      maxSlopeDeg: 5,
      batteryWh: 6000,
      nominalPowerWhPerHour: 750,
      chargeHours: [1.5, 3],
      weatherTolerance: ["clear"],
      noGoZones: false,
      remoteResume: true,
    },
    commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "ABORT"],
    confidence: 0.92,
    compliance: {
      productionOrigin: "US",
      fccStatus: "authorized",
      firmwareUpdateEligibleUntil: null,
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "relay-local-sim",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "cleanProgressPct"],
      },
    },
  },
  {
    schemaVersion: "1.0.0",
    robotId: "scrubber-02",
    vendor: "scrubbersim",
    model: "scrubber-sim-s40",
    firmwareVersion: "1.4.0-sim",
    kind: "scrubber",
    capabilities: {
      taskTypes: ["scrub"],
      maxSlopeDeg: 5,
      batteryWh: 6000,
      nominalPowerWhPerHour: 750,
      chargeHours: [1.5, 3],
      weatherTolerance: ["clear"],
      noGoZones: false,
      remoteResume: true,
    },
    commands: ["START_TASK", "PAUSE", "RESUME", "DOCK_CHARGE", "ABORT"],
    confidence: 0.91,
    compliance: {
      productionOrigin: "US",
      fccStatus: "authorized",
      firmwareUpdateEligibleUntil: null,
      dataResidency: { telemetryRegion: "us-west-2", allowCrossBorderTelemetry: false },
      dataFlow: {
        oemCloud: "relay-local-sim",
        traversedJurisdictions: ["US"],
        telemetryFieldAllowlist: ["batteryPct", "charging", "cleanProgressPct"],
      },
    },
  },
];
