import { advanceDeviceCore, applyCoreCommand, initialDeviceCore } from "../shared/device-core.js";
import type { DeviceCoreState, DeviceRates } from "../shared/device-core.js";

/**
 * Navimow (九号) vendor surface — a modeled cloud-to-cloud REST API: devices
 * publish an integer-percent battery, area-based progress, and RTK-GNSS
 * positioning state; commands are acknowledged by the cloud asynchronously
 * (modeled in the adapter as microtask settlement).
 *
 * Modeled quirks (simulator only, not a claim about any real product):
 * - position is only reported while the RTK fix is good (FIX); a FLOAT/NONE
 *   fix degrades positioning data;
 * - progress is area-based (`areaProgressPct`) rather than distance-based;
 * - virtual boundaries (no-go zones) are set from the cloud, so
 *   SET_NO_GO_ZONE is inside this vendor's allow-list;
 * - device trouble arrives as `lastErrorCode` on the polled status payload.
 */

export const NAVIMOW_DEVICE_RATES: DeviceRates = {
  drainPctPerTick: 1.5,
  chargePctPerTick: 10,
  progressPctPerTick: 10,
  hoursPerTick: 0.1,
};

export type NavimowWorkingMode =
  "STANDBY" | "MOWING" | "PAUSED" | "CHARGING" | "RETURNING" | "ERROR";

export type NavimowRtkStatus = "FIX" | "FLOAT" | "NONE";

export type NavimowFaultCode =
  | "N01_BATTERY_LOW"
  | "N02_WHEEL_BLOCKED"
  | "N03_RTK_SIGNAL_WEAK"
  | "N04_RAIN_DETECTED"
  | "N05_BLADE_SERVICE_DUE";

/** Vendor-shaped status payload for one device (`GET /openapi/v2/devices/{id}/status`). */
export interface NavimowDeviceStatus {
  deviceId: string;
  workingMode: NavimowWorkingMode;
  batteryLevel: number;
  areaProgressPct?: number;
  rtkStatus: NavimowRtkStatus;
  position?: { lat: number; lon: number };
  wheelBlocked: boolean;
  rainDetected: boolean;
  bladeMotorHours: number;
  mqttOnline: boolean;
  virtualBoundaryCount: number;
  lastErrorCode?: NavimowFaultCode;
}

export type NavimowCommandAction =
  | "startTask"
  | "pauseTask"
  | "resumeTask"
  | "dockCharge"
  | "returnHome"
  | "setVirtualBoundary"
  | "abortTask";

export class NavimowMowerDevice {
  private readonly cores = new Map<string, DeviceCoreState>();
  private readonly errorCodes = new Map<string, NavimowFaultCode>();
  private readonly rtkStatuses = new Map<string, NavimowRtkStatus>();
  private readonly boundaryCounts = new Map<string, number>();

  constructor(robotIds: readonly string[]) {
    for (const robotId of robotIds) {
      this.cores.set(robotId, initialDeviceCore());
      this.rtkStatuses.set(robotId, "FIX");
      this.boundaryCounts.set(robotId, 0);
    }
  }

  robotIds(): string[] {
    return [...this.cores.keys()];
  }

  /** Vendor status poll — battery in 1% steps, position only with an RTK fix. */
  status(robotId: string): NavimowDeviceStatus {
    const core = this.requireCore(robotId);
    const rtkStatus = this.rtkStatuses.get(robotId) ?? "NONE";
    const lastErrorCode = this.errorCodes.get(robotId);
    return {
      deviceId: robotId,
      workingMode: workingModeOf(core, lastErrorCode !== undefined),
      batteryLevel: Math.round(core.batteryPct),
      ...(core.running && !core.paused ? { areaProgressPct: core.progressPct } : {}),
      rtkStatus,
      ...(rtkStatus === "FIX" ? { position: NAVIMOW_SIM_POSE } : {}),
      wheelBlocked: false,
      rainDetected: false,
      bladeMotorHours: Math.round(core.hourMeterHours * 10) / 10,
      mqttOnline: core.uplinkUp,
      virtualBoundaryCount: this.boundaryCounts.get(robotId) ?? 0,
      ...(lastErrorCode ? { lastErrorCode } : {}),
    };
  }

  listStatuses(): NavimowDeviceStatus[] {
    return this.robotIds().map((robotId) => this.status(robotId));
  }

  /** Vendor command application (`POST /openapi/v2/devices/{id}/commands`). */
  applyCommand(robotId: string, action: NavimowCommandAction): void {
    const core = this.requireCore(robotId);
    switch (action) {
      case "startTask":
        applyCoreCommand(core, "START_TASK");
        break;
      case "pauseTask":
        applyCoreCommand(core, "PAUSE");
        break;
      case "resumeTask":
        applyCoreCommand(core, "RESUME");
        break;
      case "dockCharge":
        applyCoreCommand(core, "DOCK_CHARGE");
        break;
      case "returnHome":
        applyCoreCommand(core, "RETURN_HOME");
        break;
      case "setVirtualBoundary":
        this.boundaryCounts.set(robotId, (this.boundaryCounts.get(robotId) ?? 0) + 1);
        break;
      case "abortTask":
        applyCoreCommand(core, "ABORT");
        break;
    }
  }

  /** Scenario driver: forces the RTK fix state (GNSS degradation scenario). */
  setRtkStatus(robotId: string, status: NavimowRtkStatus): void {
    this.requireCore(robotId);
    this.rtkStatuses.set(robotId, status);
  }

  rtkStatus(robotId: string): NavimowRtkStatus {
    return this.rtkStatuses.get(robotId) ?? "NONE";
  }

  /** Latches a vendor error code onto the next status polls. */
  raiseError(robotId: string, code: NavimowFaultCode): void {
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
      advanceDeviceCore(core, NAVIMOW_DEVICE_RATES);
    }
  }

  private requireCore(robotId: string): DeviceCoreState {
    const core = this.cores.get(robotId);
    if (!core) {
      throw new Error(`Navimow sim has no device "${robotId}"`);
    }
    return core;
  }
}

/** Fixed sim plot position for the navimow fleet (synthetic coordinates). */
export const NAVIMOW_SIM_POSE = { lat: 47.6205, lon: -122.3493 } as const;

function workingModeOf(core: DeviceCoreState, hasError: boolean): NavimowWorkingMode {
  if (hasError) return "ERROR";
  if (core.charging) return "CHARGING";
  if (core.running && core.paused) return "PAUSED";
  if (core.running) return "MOWING";
  return "STANDBY";
}
