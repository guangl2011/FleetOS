import type {
  CommandPermission,
  FaultSeverity,
  FaultType,
  TelemetrySample,
} from "@fleetos/core-schema";

import type {
  HusqvarnaDeviceStatus,
  HusqvarnaFaultCode,
  HusqvarnaPlannerAction,
} from "./device.js";

/**
 * Husqvarna normalization layer — pure vendor→core-schema mappings. The
 * command map is partial by design: SET_NO_GO_ZONE is not in this vendor's
 * allow-list (work zones are planner-managed), so the map has no entry for it
 * and the adapter's command gating rejects it before dispatch.
 */
export const HUSQVARNA_COMMAND_TO_ACTION: Partial<
  Record<CommandPermission, HusqvarnaPlannerAction>
> = {
  START_TASK: "planner/start",
  PAUSE: "planner/pause",
  RESUME: "planner/resume",
  DOCK_CHARGE: "planner/dock-now",
  RETURN_HOME: "planner/park-now",
  ABORT: "planner/abort",
};

/** Normalized fault class + severity + operator-facing message per vendor code. */
export const HUSQVARNA_FAULT_CODE_MAP: Record<
  HusqvarnaFaultCode,
  { type: FaultType; severity: FaultSeverity; message: string }
> = {
  H01_BATTERY_LOW: {
    type: "BATTERY",
    severity: "critical",
    message: "battery below vendor reserve threshold",
  },
  H02_LIFT_DETECTED: {
    type: "STUCK",
    severity: "warning",
    message: "mower reported lifted or obstructed; task halted",
  },
  H03_GPS_SIGNAL_WEAK: {
    type: "SENSOR_DEGRADED",
    severity: "warning",
    message: "GPS position fix degraded or lost",
  },
  H04_WEATHER_TIMER: {
    type: "WEATHER_HOLD",
    severity: "info",
    message: "weather timer active; mowing held",
  },
  H05_SERVICE_DUE: {
    type: "MAINTENANCE_DUE",
    severity: "info",
    message: "service interval reached",
  },
};

/** Reverse map: normalized fault class → vendor code (null when transport-level). */
export const HUSQVARNA_FAULT_TYPE_TO_CODE: Record<FaultType, HusqvarnaFaultCode | null> = {
  BATTERY: "H01_BATTERY_LOW",
  STUCK: "H02_LIFT_DETECTED",
  SENSOR_DEGRADED: "H03_GPS_SIGNAL_WEAK",
  COMMS_LOST: null, // transport-level; emitted by the adapter, not the device
  WEATHER_HOLD: "H04_WEATHER_TIMER",
  MAINTENANCE_DUE: "H05_SERVICE_DUE",
};

/** Vendor status payload → normalized telemetry sample (pure; ts supplied by the adapter clock). */
export function husqvarnaStatusToTelemetry(
  status: HusqvarnaDeviceStatus,
  ts: string,
): TelemetrySample {
  return {
    robotId: status.mowerId,
    ts,
    batteryPct: status.mower.batteryLevel,
    charging: status.mower.activity === "CHARGING",
    ...(status.gps ? { pose: { lat: status.gps.latitude, lon: status.gps.longitude } } : {}),
    ...(status.plannerTaskProgressPct !== undefined
      ? { progressPct: status.plannerTaskProgressPct }
      : {}),
  };
}
