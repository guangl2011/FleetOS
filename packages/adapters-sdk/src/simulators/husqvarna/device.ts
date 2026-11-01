import { advanceDeviceCore, applyCoreCommand, initialDeviceCore } from "../shared/device-core.js";
import type { DeviceCoreState, DeviceRates } from "../shared/device-core.js";

/**
 * Husqvarna vendor surface — a modeled Open API: an OAuth-style access token
 * gates the connection (modeled in the adapter with a tick-counted TTL and
 * auto-refresh), and commands are planner-style verbs issued to a work
 * planner (`/work-plans`), not raw device overrides. Work zones are managed
 * in the vendor planner, so there is no set-boundary command here.
 *
 * Modeled quirks (simulator only, not a claim about any real product):
 * - positions only carry a GPS payload while the device has a fix;
 * - activity is a coarse vendor enum (see `HusqvarnaActivity`);
 * - device trouble arrives as an `errorCode` on the polled status payload.
 */

export const HUSQVARNA_DEVICE_RATES: DeviceRates = {
  drainPctPerTick: 1.4,
  chargePctPerTick: 11,
  progressPctPerTick: 9,
  hoursPerTick: 0.1,
};

export type HusqvarnaActivity = "PARKED" | "MOWING" | "PAUSED" | "CHARGING" | "RETURNING" | "ERROR";

export type HusqvarnaGpsFix = "OK" | "NONE";

export type HusqvarnaFaultCode =
  | "H01_BATTERY_LOW"
  | "H02_LIFT_DETECTED"
  | "H03_GPS_SIGNAL_WEAK"
  | "H04_WEATHER_TIMER"
  | "H05_SERVICE_DUE";

/** Vendor-shaped status payload for one mower (`GET /mowers/{id}/status`). */
export interface HusqvarnaDeviceStatus {
  mowerId: string;
  system: { connected: boolean };
  mower: {
    activity: HusqvarnaActivity;
    batteryLevel: number;
    errorCode?: HusqvarnaFaultCode;
    bladeMotorHours: number;
  };
  gps?: { latitude: number; longitude: number; fix: HusqvarnaGpsFix };
  plannerTaskProgressPct?: number;
}

export type HusqvarnaPlannerAction =
  | "planner/start"
  | "planner/pause"
  | "planner/resume"
  | "planner/dock-now"
  | "planner/park-now"
  | "planner/abort";

export class HusqvarnaPlannerSim {
  private readonly cores = new Map<string, DeviceCoreState>();
  private readonly errorCodes = new Map<string, HusqvarnaFaultCode>();
  private readonly gpsFixes = new Map<string, HusqvarnaGpsFix>();

  constructor(robotIds: readonly string[]) {
    for (const robotId of robotIds) {
      this.cores.set(robotId, initialDeviceCore());
      this.gpsFixes.set(robotId, "OK");
    }
  }

  robotIds(): string[] {
    return [...this.cores.keys()];
  }

  /** Vendor status poll — position only while the GPS fix is good. */
  status(robotId: string): HusqvarnaDeviceStatus {
    const core = this.requireCore(robotId);
    const gpsFix = this.gpsFixes.get(robotId) ?? "NONE";
    const lastErrorCode = this.errorCodes.get(robotId);
    const mowing = core.running && !core.paused && !core.charging;
    return {
      mowerId: robotId,
      system: { connected: core.uplinkUp },
      mower: {
        activity: activityOf(core, lastErrorCode !== undefined),
        batteryLevel: Math.round(core.batteryPct),
        ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
        bladeMotorHours: Math.round(core.hourMeterHours * 10) / 10,
      },
      ...(gpsFix === "OK"
        ? {
            gps: {
              latitude: HUSQVARNA_SIM_POSE.lat,
              longitude: HUSQVARNA_SIM_POSE.lon,
              fix: gpsFix,
            },
          }
        : {}),
      ...(mowing ? { plannerTaskProgressPct: core.progressPct } : {}),
    };
  }

  listStatuses(): HusqvarnaDeviceStatus[] {
    return this.robotIds().map((robotId) => this.status(robotId));
  }

  /** Planner command application (`POST /work-plans/{id}/actions`). */
  applyCommand(robotId: string, action: HusqvarnaPlannerAction): void {
    const core = this.requireCore(robotId);
    switch (action) {
      case "planner/start":
        applyCoreCommand(core, "START_TASK");
        break;
      case "planner/pause":
        applyCoreCommand(core, "PAUSE");
        break;
      case "planner/resume":
        applyCoreCommand(core, "RESUME");
        break;
      case "planner/dock-now":
        applyCoreCommand(core, "DOCK_CHARGE");
        break;
      case "planner/park-now":
        applyCoreCommand(core, "RETURN_HOME");
        break;
      case "planner/abort":
        applyCoreCommand(core, "ABORT");
        break;
    }
  }

  /** Scenario driver: forces the GPS fix state (GNSS degradation scenario). */
  setGpsFix(robotId: string, fix: HusqvarnaGpsFix): void {
    this.requireCore(robotId);
    this.gpsFixes.set(robotId, fix);
  }

  gpsFix(robotId: string): HusqvarnaGpsFix {
    return this.gpsFixes.get(robotId) ?? "NONE";
  }

  /** Latches a vendor error code onto the next status polls. */
  raiseError(robotId: string, code: HusqvarnaFaultCode): void {
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
      advanceDeviceCore(core, HUSQVARNA_DEVICE_RATES);
    }
  }

  private requireCore(robotId: string): DeviceCoreState {
    const core = this.cores.get(robotId);
    if (!core) {
      throw new Error(`Husqvarna sim has no mower "${robotId}"`);
    }
    return core;
  }
}

/** Fixed sim plot position for the husqvarna fleet (synthetic coordinates). */
export const HUSQVARNA_SIM_POSE = { lat: 47.6442, lon: -122.1307 } as const;

function activityOf(core: DeviceCoreState, hasError: boolean): HusqvarnaActivity {
  if (hasError) return "ERROR";
  if (core.charging) return "CHARGING";
  if (core.running && core.paused) return "PAUSED";
  if (core.running) return "MOWING";
  return "PARKED";
}
