import { advanceDeviceCore, applyCoreCommand, initialDeviceCore } from "../shared/device-core.js";
import type { DeviceCoreState, DeviceRates } from "../shared/device-core.js";

/**
 * The vendor's coarse battery field: reported in 5% steps (truncated). The
 * adapter never smooths it — the world model sees exactly what the vendor
 * exposes, and the reduced resolution is data the confidence layer can weigh.
 */
export function stepBatteryTo5(pct: number): number {
  return Math.floor(pct / 5) * 5;
}

/**
 * Greenworks vendor surface — a modeled local-gateway cloud API (coarse
 * battery reporting, statusCode polling, blade-hour maintenance meter).
 *
 * Modeled quirks (simulator only, not a claim about any real product):
 * - battery is reported in coarse 5% steps (`batteryPercent`);
 * - progress is exposed only while the statusCode is MOWING;
 * - there is no dynamic-geofence command — boundaries are fixed at the
 *   gateway, so SET_NO_GO_ZONE is outside this vendor's allow-list;
 * - device trouble arrives as `lastErrorCode` on the polled status payload.
 */

export const GREENWORKS_DEVICE_RATES: DeviceRates = {
  drainPctPerTick: 2,
  chargePctPerTick: 8,
  progressPctPerTick: 5,
  hoursPerTick: 0.1,
};

export type GreenworksStatusCode =
  "IDLE" | "MOWING" | "PAUSED" | "CHARGING" | "RETURNING" | "ERROR";

export type GreenworksFaultCode =
  | "E01_BATTERY_LOW"
  | "E02_STALLED"
  | "E03_BUMPER_OCCLUDED"
  | "E04_RAIN_DELAY"
  | "E05_BLADE_SERVICE_DUE";

/** Vendor-shaped status payload for one mower (`GET /v1/mowers/{id}`). */
export interface GreenworksMowerStatus {
  mowerId: string;
  statusCode: GreenworksStatusCode;
  batteryPercent: number;
  isCharging: boolean;
  mowProgressPercent?: number;
  bladeMotorHours: number;
  lastErrorCode?: GreenworksFaultCode;
}

export type GreenworksCommandAction =
  "startMowing" | "pauseMowing" | "resumeMowing" | "dockForCharging" | "returnToDock" | "abortJob";

export class GreenworksMowerDevice {
  private readonly cores = new Map<string, DeviceCoreState>();
  /** Latched vendor error code, surfaced on every poll until cleared. */
  private readonly errorCodes = new Map<string, GreenworksFaultCode>();

  constructor(robotIds: readonly string[]) {
    for (const robotId of robotIds) {
      this.cores.set(robotId, initialDeviceCore());
    }
  }

  robotIds(): string[] {
    return [...this.cores.keys()];
  }

  /** Vendor status poll — battery stepped to 5%, progress only while MOWING. */
  status(robotId: string): GreenworksMowerStatus {
    const core = this.requireCore(robotId);
    const lastErrorCode = this.errorCodes.get(robotId);
    return {
      mowerId: robotId,
      statusCode: statusCodeOf(core, lastErrorCode !== undefined),
      batteryPercent: stepBatteryTo5(core.batteryPct),
      isCharging: core.charging,
      ...(core.running && !core.paused ? { mowProgressPercent: core.progressPct } : {}),
      bladeMotorHours: Math.round(core.hourMeterHours * 10) / 10,
      ...(lastErrorCode ? { lastErrorCode } : {}),
    };
  }

  listStatuses(): GreenworksMowerStatus[] {
    return this.robotIds().map((robotId) => this.status(robotId));
  }

  /** Vendor command application (`POST /v1/mowers/{id}/commands`). */
  applyCommand(robotId: string, action: GreenworksCommandAction): void {
    const core = this.requireCore(robotId);
    switch (action) {
      case "startMowing":
        applyCoreCommand(core, "START_TASK");
        break;
      case "pauseMowing":
        applyCoreCommand(core, "PAUSE");
        break;
      case "resumeMowing":
        applyCoreCommand(core, "RESUME");
        break;
      case "dockForCharging":
        applyCoreCommand(core, "DOCK_CHARGE");
        break;
      case "returnToDock":
        applyCoreCommand(core, "RETURN_HOME");
        break;
      case "abortJob":
        applyCoreCommand(core, "ABORT");
        break;
    }
  }

  /** Latches a vendor error code onto the next status polls. */
  raiseError(robotId: string, code: GreenworksFaultCode): void {
    this.requireCore(robotId);
    this.errorCodes.set(robotId, code);
  }

  clearError(robotId: string): void {
    this.errorCodes.delete(robotId);
  }

  setUplink(robotId: string, up: boolean): void {
    this.requireCore(robotId).uplinkUp = up;
  }

  uplinkUp(robotId: string): boolean {
    return this.requireCore(robotId).uplinkUp;
  }

  tick(): void {
    for (const core of this.cores.values()) {
      advanceDeviceCore(core, GREENWORKS_DEVICE_RATES);
    }
  }

  private requireCore(robotId: string): DeviceCoreState {
    const core = this.cores.get(robotId);
    if (!core) {
      throw new Error(`Greenworks sim has no mower "${robotId}"`);
    }
    return core;
  }
}

function statusCodeOf(core: DeviceCoreState, hasError: boolean): GreenworksStatusCode {
  if (hasError) return "ERROR";
  if (core.charging) return "CHARGING";
  if (core.running && core.paused) return "PAUSED";
  if (core.running) return "MOWING";
  return "IDLE";
}
