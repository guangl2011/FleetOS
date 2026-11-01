import { advanceDeviceCore, applyCoreCommand, initialDeviceCore } from "../shared/device-core.js";
import type { DeviceCoreState, DeviceRates } from "../shared/device-core.js";

/**
 * Scrubber vendor surface — a modeled relay-style local WiFi API: synchronous
 * command execution, sensor-health-keyed localization, deck-jam detection,
 * and brush wear derived from motor hours. Progress is cleaning-area based.
 */

export const SCRUBBER_DEVICE_RATES: DeviceRates = {
  drainPctPerTick: 1.2,
  chargePctPerTick: 12,
  progressPctPerTick: 8,
  hoursPerTick: 0.1,
};

export type ScrubberOperationState =
  "IDLE" | "CLEANING" | "PAUSED" | "CHARGING" | "RETURNING" | "FAULT";

export type ScrubberSensorHealth = "OK" | "DEGRADED";

export type ScrubberFaultCode =
  | "S01_BATTERY_LOW"
  | "S02_DECK_JAM"
  | "S03_SENSOR_DIRTY"
  | "S04_OUTDOOR_HOLD"
  | "S05_BRUSH_WEAR_LIMIT";

/** Vendor-shaped status payload for one unit (relay API status message). */
export interface ScrubberUnitStatus {
  unitId: string;
  operationState: ScrubberOperationState;
  batteryPercent: number;
  cleanProgressPercent?: number;
  brushWearPct: number;
  sensorHealth: ScrubberSensorHealth;
  localizationPose?: { lat: number; lon: number };
  deckJammed: boolean;
  outdoorTransitHold: boolean;
  wifiOnline: boolean;
  lastErrorCode?: ScrubberFaultCode;
}

export type ScrubberCommandAction = "startCleaning" | "pause" | "resume" | "dock" | "abort";

export class ScrubberRelaySim {
  private readonly cores = new Map<string, DeviceCoreState>();
  private readonly errorCodes = new Map<string, ScrubberFaultCode>();
  private readonly sensorHealths = new Map<string, ScrubberSensorHealth>();
  private readonly deckJams = new Map<string, boolean>();
  private readonly outdoorHolds = new Map<string, boolean>();

  constructor(robotIds: readonly string[]) {
    for (const robotId of robotIds) {
      this.cores.set(robotId, initialDeviceCore());
      this.sensorHealths.set(robotId, "OK");
      this.deckJams.set(robotId, false);
      this.outdoorHolds.set(robotId, false);
    }
  }

  robotIds(): string[] {
    return [...this.cores.keys()];
  }

  /** Vendor status poll — pose suppressed entirely when sensors degrade. */
  status(robotId: string): ScrubberUnitStatus {
    const core = this.requireCore(robotId);
    const sensorHealth = this.sensorHealths.get(robotId) ?? "DEGRADED";
    const lastErrorCode = this.errorCodes.get(robotId);
    const deckJammed = this.deckJams.get(robotId) ?? false;
    const cleaning = core.running && !core.paused && !core.charging;
    return {
      unitId: robotId,
      operationState: operationStateOf(core, lastErrorCode !== undefined),
      batteryPercent: Math.round(core.batteryPct),
      ...(cleaning ? { cleanProgressPercent: core.progressPct } : {}),
      brushWearPct: brushWearPctOf(core.hourMeterHours),
      sensorHealth,
      ...(sensorHealth === "OK" ? { localizationPose: SCRUBBER_SIM_POSE } : {}),
      deckJammed,
      outdoorTransitHold: this.outdoorHolds.get(robotId) ?? false,
      wifiOnline: core.uplinkUp,
      ...(lastErrorCode ? { lastErrorCode } : {}),
    };
  }

  listStatuses(): ScrubberUnitStatus[] {
    return this.robotIds().map((robotId) => this.status(robotId));
  }

  /** Relay command application (synchronous local API). */
  applyCommand(robotId: string, action: ScrubberCommandAction): void {
    const core = this.requireCore(robotId);
    switch (action) {
      case "startCleaning":
        applyCoreCommand(core, "START_TASK");
        break;
      case "pause":
        applyCoreCommand(core, "PAUSE");
        break;
      case "resume":
        applyCoreCommand(core, "RESUME");
        break;
      case "dock":
        applyCoreCommand(core, "DOCK_CHARGE");
        break;
      case "abort":
        applyCoreCommand(core, "ABORT");
        break;
    }
  }

  /** Scenario driver: forces a unit's sensor health (sensor degradation scenario). */
  setSensorHealth(robotId: string, health: ScrubberSensorHealth): void {
    this.requireCore(robotId);
    this.sensorHealths.set(robotId, health);
  }

  /** Scenario driver: forces a deck jam on/off (brush-jam scenario). */
  setDeckJammed(robotId: string, jammed: boolean): void {
    this.requireCore(robotId);
    this.deckJams.set(robotId, jammed);
  }

  /** Scenario driver: holds a unit outdoors (weather-hold normalization path). */
  setOutdoorTransitHold(robotId: string, held: boolean): void {
    this.requireCore(robotId);
    this.outdoorHolds.set(robotId, held);
  }

  /** Latches a vendor error code onto the next status polls. */
  raiseError(robotId: string, code: ScrubberFaultCode): void {
    this.requireCore(robotId);
    this.errorCodes.set(robotId, code);
  }

  setUplink(robotId: string, up: boolean): void {
    this.requireCore(robotId).uplinkUp = up;
  }

  uplinkUp(robotId: string): boolean {
    return this.requireCore(robotId).uplinkUp;
  }

  tick(): void {
    for (const core of this.cores.values()) {
      advanceDeviceCore(core, SCRUBBER_DEVICE_RATES);
    }
  }

  private requireCore(robotId: string): DeviceCoreState {
    const core = this.cores.get(robotId);
    if (!core) {
      throw new Error(`Scrubber sim has no unit "${robotId}"`);
    }
    return core;
  }
}

/** Fixed sim plot position for the scrubber fleet (synthetic coordinates). */
export const SCRUBBER_SIM_POSE = { lat: 47.6155, lon: -122.2035 } as const;

/** Brush wear derives deterministically from motor hours (no extra state). */
function brushWearPctOf(hourMeterHours: number): number {
  return Math.min(100, Math.round(40 + hourMeterHours * 20));
}

function operationStateOf(core: DeviceCoreState, hasError: boolean): ScrubberOperationState {
  if (hasError) return "FAULT";
  if (core.charging) return "CHARGING";
  if (core.running && core.paused) return "PAUSED";
  if (core.running) return "CLEANING";
  return "IDLE";
}
