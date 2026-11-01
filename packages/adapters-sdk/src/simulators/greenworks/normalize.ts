import type {
  CommandPermission,
  FaultSeverity,
  FaultType,
  TelemetrySample,
} from "@fleetos/core-schema";

import type {
  GreenworksCommandAction,
  GreenworksFaultCode,
  GreenworksMowerStatus,
} from "./device.js";

/**
 * Greenworks normalization layer — the pure vendor→core-schema mappings a
 * real integration would write against the OEM API. Simulators and physical
 * adapters share these functions; the contract suite holds both to the same
 * normalization behavior.
 */

/**
 * Command → vendor action map. SET_NO_GO_ZONE is deliberately absent: the
 * modeled gateway API has no dynamic-geofence command, so the capability
 * allow-list for this vendor never contains it and gating rejects it before
 * dispatch. The Exclude type makes that invariant compile-checked.
 */
export const GREENWORKS_COMMAND_TO_ACTION: {
  [K in Exclude<CommandPermission, "SET_NO_GO_ZONE">]: GreenworksCommandAction;
} = {
  START_TASK: "startMowing",
  PAUSE: "pauseMowing",
  RESUME: "resumeMowing",
  DOCK_CHARGE: "dockForCharging",
  RETURN_HOME: "returnToDock",
  ABORT: "abortJob",
};

/** Normalized fault class + severity + operator-facing message per vendor code. */
export const GREENWORKS_FAULT_CODE_MAP: Record<
  GreenworksFaultCode,
  { type: FaultType; severity: FaultSeverity; message: string }
> = {
  E01_BATTERY_LOW: {
    type: "BATTERY",
    severity: "critical",
    message: "battery below vendor low-voltage cutoff",
  },
  E02_STALLED: {
    type: "STUCK",
    severity: "warning",
    message: "drive stalled; mower stopped on terrain",
  },
  E03_BUMPER_OCCLUDED: {
    type: "SENSOR_DEGRADED",
    severity: "warning",
    message: "bumper sensor blocked or occluded",
  },
  E04_RAIN_DELAY: {
    type: "WEATHER_HOLD",
    severity: "info",
    message: "rain delay hold active",
  },
  E05_BLADE_SERVICE_DUE: {
    type: "MAINTENANCE_DUE",
    severity: "info",
    message: "blade motor hours past service interval",
  },
};

/** Reverse map: normalized fault class → this vendor's error code (null when transport-level). */
export const GREENWORKS_FAULT_TYPE_TO_CODE: Record<FaultType, GreenworksFaultCode | null> = {
  BATTERY: "E01_BATTERY_LOW",
  STUCK: "E02_STALLED",
  SENSOR_DEGRADED: "E03_BUMPER_OCCLUDED",
  COMMS_LOST: null, // transport-level; emitted by the adapter, not the device
  WEATHER_HOLD: "E04_RAIN_DELAY",
  MAINTENANCE_DUE: "E05_BLADE_SERVICE_DUE",
};

/** Vendor status payload → normalized telemetry sample (pure; ts supplied by the adapter clock). */
export function greenworksStatusToTelemetry(
  status: GreenworksMowerStatus,
  ts: string,
): TelemetrySample {
  return {
    robotId: status.mowerId,
    ts,
    batteryPct: status.batteryPercent,
    charging: status.isCharging,
    // Perimeter-wire models report position from odometry; the sim's fixed
    // plot keeps the sample schema-valid and the pose honest about precision.
    pose: GREENWORKS_SIM_POSE,
    ...(status.mowProgressPercent !== undefined ? { progressPct: status.mowProgressPercent } : {}),
  };
}

/** Fixed sim plot position for the greenworks fleet (synthetic coordinates). */
export const GREENWORKS_SIM_POSE = { lat: 47.6104, lon: -122.335 } as const;
