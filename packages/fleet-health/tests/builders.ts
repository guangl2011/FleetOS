import type { FaultEvent, GeoPoint, TelemetrySample } from "@fleetos/core-schema";

/** Fixed instant — no wall clock anywhere (repo determinism convention). */
export const T0 = "2026-11-02T08:00:00.000Z";

export const POSE: GeoPoint = { lat: 47.6, lon: -122.3 };

export function faultEvent(overrides: Partial<FaultEvent> = {}): FaultEvent {
  return {
    faultId: "fault-robot-mower-01-BATTERY-1",
    robotId: "robot-mower-01",
    ts: T0,
    type: "BATTERY",
    severity: "critical",
    message: "battery below vendor low-voltage cutoff",
    ...overrides,
  };
}

export function telemetrySample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    robotId: "robot-mower-01",
    ts: T0,
    batteryPct: 76,
    charging: false,
    ...overrides,
  };
}
