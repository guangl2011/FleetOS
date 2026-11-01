import type { CommandPermission } from "@fleetos/core-schema";

import type { ManualClock } from "../../clock.js";

/**
 * Shared device physics for all four simulators: battery, task progress,
 * charge state, the vendor hour meter (blade hours for mowers, brush hours
 * for scrubbers), and the per-robot uplink flag. Vendor simulators embed this
 * core and wrap it in their OEM payload shape — the physics are common, the
 * API surfaces are not.
 */

/** Per-tick physics rates; every value is vendor-chosen and deterministic. */
export interface DeviceRates {
  readonly drainPctPerTick: number;
  readonly chargePctPerTick: number;
  readonly progressPctPerTick: number;
  readonly hoursPerTick: number;
}

export interface DeviceCoreState {
  batteryPct: number;
  charging: boolean;
  running: boolean;
  paused: boolean;
  progressPct: number;
  /** Vendor-side link to this robot; telemetry only flows while true. */
  uplinkUp: boolean;
  /** Vendor hour meter (blade/brush hours). */
  hourMeterHours: number;
}

export function initialDeviceCore(batteryPct = 80): DeviceCoreState {
  return {
    batteryPct,
    charging: false,
    running: false,
    paused: false,
    progressPct: 0,
    uplinkUp: true,
    hourMeterHours: 0,
  };
}

/**
 * Advances one simulated tick: charging fills the battery; active work drains
 * it and advances task progress. The tick that emits the final 100% sample
 * also retires the task (progress resets, work stops) — same semantics as the
 * reference adapter, so all five adapters read identically downstream.
 */
export function advanceDeviceCore(state: DeviceCoreState, rates: DeviceRates): void {
  if (state.charging) {
    state.batteryPct = Math.min(100, state.batteryPct + rates.chargePctPerTick);
    return;
  }
  if (state.running && !state.paused) {
    state.batteryPct = Math.max(0, state.batteryPct - rates.drainPctPerTick);
    state.progressPct = Math.min(100, state.progressPct + rates.progressPctPerTick);
    state.hourMeterHours += rates.hoursPerTick;
    if (state.progressPct >= 100) {
      state.running = false;
      state.progressPct = 0;
    }
  }
}

/**
 * Shared command semantics across simulators. SET_NO_GO_ZONE is a vendor
 * boundary feature (present in some OEM APIs, absent in others) — the core
 * ignores it and the vendor device layer decides.
 */
export function applyCoreCommand(state: DeviceCoreState, command: CommandPermission): void {
  switch (command) {
    case "START_TASK":
      state.running = true;
      state.paused = false;
      state.charging = false;
      break;
    case "PAUSE":
      state.paused = true;
      break;
    case "RESUME":
      state.paused = false;
      break;
    case "DOCK_CHARGE":
      state.charging = true;
      state.running = false;
      break;
    case "RETURN_HOME":
      state.charging = false;
      state.running = false;
      break;
    case "ABORT":
      state.running = false;
      state.paused = false;
      break;
    case "SET_NO_GO_ZONE":
      break;
  }
}

/** Options shared by all four simulator adapters. */
export interface SimulatorAdapterOptions {
  /** Defaults to a fresh ManualClock; tests inject one to assert timestamps. */
  readonly clock?: ManualClock;
}
