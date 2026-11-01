import type { FaultEvent } from "@fleetos/core-schema";

import { WorldModelError } from "./errors.js";

/**
 * Per-robot confidence estimation — deterministic and explainable (spec D1:
 * the world model "knows what it doesn't know", and the benchmark measures
 * calibration on top of these estimates). Confidence is a product of three
 * factors, each named so an operator can read why a number moved:
 *
 *   confidence = baseQuality × freshness × faultFactor
 *
 * - baseQuality — the adapter-reported data quality on the Robot record.
 * - freshness — 1 within the fresh window, then exponential decay with a
 *   half-life, 0 past the unreachable threshold.
 * - faultFactor — a per-fault-class trust multiplier (COMMS_LOST destroys
 *   trust, SENSOR_DEGRADED halves it, other active faults trim it).
 */
export interface ConfidenceTuning {
  /** Data at most this old is fully fresh. */
  readonly freshWithinSeconds: number;
  /** Freshness halves per this much age beyond the fresh window. */
  readonly halfLifeSeconds: number;
  /** State derivation: data older than this is `stale`. */
  readonly staleAfterSeconds: number;
  /** State derivation: data older than this is `unreachable`; freshness is 0. */
  readonly unreachableAfterSeconds: number;
  /** Trust multiplier while a SENSOR_DEGRADED fault is active. */
  readonly sensorDegradedFactor: number;
  /** Trust multiplier while any other operational fault is active. */
  readonly faultedFactor: number;
  /** Trust multiplier while a COMMS_LOST fault is active. */
  readonly commsLostFactor: number;
}

export const DEFAULT_CONFIDENCE_TUNING: ConfidenceTuning = {
  freshWithinSeconds: 120,
  halfLifeSeconds: 300,
  staleAfterSeconds: 600,
  unreachableAfterSeconds: 1800,
  sensorDegradedFactor: 0.5,
  faultedFactor: 0.7,
  commsLostFactor: 0.1,
};

/**
 * Merges partial overrides onto the defaults, refusing nonsense loudly:
 * negative or non-finite windows, factors outside [0, 1], and a stale
 * threshold at or beyond the unreachable threshold (states would be
 * unreachable before they were stale).
 */
export function mergeTuning(overrides?: Partial<ConfidenceTuning>): ConfidenceTuning {
  const tuning: ConfidenceTuning = { ...DEFAULT_CONFIDENCE_TUNING, ...overrides };
  const windows: readonly (keyof ConfidenceTuning)[] = [
    "freshWithinSeconds",
    "halfLifeSeconds",
    "staleAfterSeconds",
    "unreachableAfterSeconds",
  ];
  for (const key of windows) {
    const value = tuning[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new WorldModelError("TUNING_INVALID", `${key} must be a non-negative finite number`);
    }
  }
  const factors: readonly (keyof ConfidenceTuning)[] = [
    "sensorDegradedFactor",
    "faultedFactor",
    "commsLostFactor",
  ];
  for (const key of factors) {
    const value = tuning[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new WorldModelError("TUNING_INVALID", `${key} must be in [0, 1]`);
    }
  }
  if (tuning.staleAfterSeconds > tuning.unreachableAfterSeconds) {
    throw new WorldModelError(
      "TUNING_INVALID",
      "staleAfterSeconds must be at most unreachableAfterSeconds",
    );
  }
  return tuning;
}

/** Freshness in [0, 1]: 1 within the fresh window, exponential decay beyond, 0 past unreachable. */
export function freshnessFactor(ageSeconds: number, tuning: ConfidenceTuning): number {
  if (ageSeconds <= tuning.freshWithinSeconds) {
    return 1;
  }
  if (ageSeconds > tuning.unreachableAfterSeconds) {
    return 0;
  }
  const aged = ageSeconds - tuning.freshWithinSeconds;
  return Math.pow(0.5, aged / tuning.halfLifeSeconds);
}

/** Trust multiplier for the active fault's class; no active fault = full trust. */
export function faultFactor(activeFault: FaultEvent | null, tuning: ConfidenceTuning): number {
  if (activeFault === null) {
    return 1;
  }
  switch (activeFault.type) {
    case "COMMS_LOST":
      return tuning.commsLostFactor;
    case "SENSOR_DEGRADED":
      return tuning.sensorDegradedFactor;
    default:
      return tuning.faultedFactor;
  }
}

/**
 * The per-robot confidence estimate in [0, 1]. A robot with no telemetry
 * ever received scores 0 — no data, no trust — which is the typed-honest
 * reading of "unknown", not a silent default.
 */
export function estimateConfidence(
  baseQuality: number,
  dataAgeSeconds: number | null,
  activeFault: FaultEvent | null,
  tuning: ConfidenceTuning,
): number {
  if (dataAgeSeconds === null) {
    return 0;
  }
  const raw =
    baseQuality * freshnessFactor(dataAgeSeconds, tuning) * faultFactor(activeFault, tuning);
  return Math.min(1, Math.max(0, raw));
}
