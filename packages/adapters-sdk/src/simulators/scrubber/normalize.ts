import type {
  CommandPermission,
  FaultSeverity,
  FaultType,
  TelemetrySample,
} from "@fleetos/core-schema";

import type { ScrubberCommandAction, ScrubberFaultCode, ScrubberUnitStatus } from "./device.js";

/**
 * Scrubber normalization layer — pure vendor→core-schema mappings. The
 * command map is partial by design: the relay API has no return-home and no
 * boundary concept, so RETURN_HOME and SET_NO_GO_ZONE have no entries and the
 * adapter's command gating rejects them before dispatch.
 */
export const SCRUBBER_COMMAND_TO_ACTION: Partial<Record<CommandPermission, ScrubberCommandAction>> =
  {
    START_TASK: "startCleaning",
    PAUSE: "pause",
    RESUME: "resume",
    DOCK_CHARGE: "dock",
    ABORT: "abort",
  };

/** Normalized fault class + severity + operator-facing message per vendor code. */
export const SCRUBBER_FAULT_CODE_MAP: Record<
  ScrubberFaultCode,
  { type: FaultType; severity: FaultSeverity; message: string }
> = {
  S01_BATTERY_LOW: {
    type: "BATTERY",
    severity: "critical",
    message: "battery below vendor reserve threshold",
  },
  S02_DECK_JAM: {
    type: "STUCK",
    severity: "warning",
    message: "deck jam detected; cleaning halted",
  },
  S03_SENSOR_DIRTY: {
    type: "SENSOR_DEGRADED",
    severity: "warning",
    message: "sensors dirty; localization suppressed",
  },
  S04_OUTDOOR_HOLD: {
    type: "WEATHER_HOLD",
    severity: "info",
    message: "unit held outdoors; cleaning held",
  },
  S05_BRUSH_WEAR_LIMIT: {
    type: "MAINTENANCE_DUE",
    severity: "info",
    message: "brush wear past service threshold",
  },
};

/** Reverse map: normalized fault class → vendor code (null when transport-level). */
export const SCRUBBER_FAULT_TYPE_TO_CODE: Record<FaultType, ScrubberFaultCode | null> = {
  BATTERY: "S01_BATTERY_LOW",
  STUCK: "S02_DECK_JAM",
  SENSOR_DEGRADED: "S03_SENSOR_DIRTY",
  COMMS_LOST: null, // transport-level; emitted by the adapter, not the device
  WEATHER_HOLD: "S04_OUTDOOR_HOLD",
  MAINTENANCE_DUE: "S05_BRUSH_WEAR_LIMIT",
};

/** Vendor status payload → normalized telemetry sample (pure; ts supplied by the adapter clock). */
export function scrubberStatusToTelemetry(status: ScrubberUnitStatus, ts: string): TelemetrySample {
  return {
    robotId: status.unitId,
    ts,
    batteryPct: status.batteryPercent,
    charging: status.operationState === "CHARGING",
    ...(status.localizationPose ? { pose: status.localizationPose } : {}),
    ...(status.cleanProgressPercent !== undefined
      ? { progressPct: status.cleanProgressPercent }
      : {}),
  };
}
