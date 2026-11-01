import type {
  CommandPermission,
  FaultSeverity,
  FaultType,
  TelemetrySample,
} from "@fleetos/core-schema";

import type { NavimowCommandAction, NavimowDeviceStatus, NavimowFaultCode } from "./device.js";

/**
 * Navimow normalization layer — pure vendor→core-schema mappings. This is the
 * full command map (all seven permissions): the modeled cloud API accepts
 * cloud-side virtual boundaries, so SET_NO_GO_ZONE is in this vendor's
 * allow-list.
 */
export const NAVIMOW_COMMAND_TO_ACTION: Record<CommandPermission, NavimowCommandAction> = {
  START_TASK: "startTask",
  PAUSE: "pauseTask",
  RESUME: "resumeTask",
  DOCK_CHARGE: "dockCharge",
  RETURN_HOME: "returnHome",
  SET_NO_GO_ZONE: "setVirtualBoundary",
  ABORT: "abortTask",
};

/** Normalized fault class + severity + operator-facing message per vendor code. */
export const NAVIMOW_FAULT_CODE_MAP: Record<
  NavimowFaultCode,
  { type: FaultType; severity: FaultSeverity; message: string }
> = {
  N01_BATTERY_LOW: {
    type: "BATTERY",
    severity: "critical",
    message: "battery below vendor reserve threshold",
  },
  N02_WHEEL_BLOCKED: {
    type: "STUCK",
    severity: "warning",
    message: "wheel reported blocked; task halted",
  },
  N03_RTK_SIGNAL_WEAK: {
    type: "SENSOR_DEGRADED",
    severity: "warning",
    message: "RTK position fix degraded or lost",
  },
  N04_RAIN_DETECTED: {
    type: "WEATHER_HOLD",
    severity: "info",
    message: "rain detected; mowing held",
  },
  N05_BLADE_SERVICE_DUE: {
    type: "MAINTENANCE_DUE",
    severity: "info",
    message: "blade hours past service interval",
  },
};

/** Reverse map: normalized fault class → vendor code (null when transport-level). */
export const NAVIMOW_FAULT_TYPE_TO_CODE: Record<FaultType, NavimowFaultCode | null> = {
  BATTERY: "N01_BATTERY_LOW",
  STUCK: "N02_WHEEL_BLOCKED",
  SENSOR_DEGRADED: "N03_RTK_SIGNAL_WEAK",
  COMMS_LOST: null, // transport-level; emitted by the adapter, not the device
  WEATHER_HOLD: "N04_RAIN_DETECTED",
  MAINTENANCE_DUE: "N05_BLADE_SERVICE_DUE",
};

/** Vendor status payload → normalized telemetry sample (pure; ts supplied by the adapter clock). */
export function navimowStatusToTelemetry(status: NavimowDeviceStatus, ts: string): TelemetrySample {
  return {
    robotId: status.deviceId,
    ts,
    batteryPct: status.batteryLevel,
    charging: status.workingMode === "CHARGING",
    ...(status.position ? { pose: status.position } : {}),
    ...(status.areaProgressPct !== undefined ? { progressPct: status.areaProgressPct } : {}),
  };
}
