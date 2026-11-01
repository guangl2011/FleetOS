import type {
  DailyWindow,
  EnergyCostCurve,
  ExternalConstraintPack,
  HardConstraint,
  WeightedConstraint,
  WeatherCondition,
} from "@fleetos/core-schema";

import type { VersionedConstraintPack } from "../src/index.js";

export function hardTimeWindow(
  constraintId: string,
  forbiddenWindows: DailyWindow[],
  description = `hard time window ${constraintId}`,
): HardConstraint {
  return { rule: "time-window", constraintId, description, forbiddenWindows };
}

export function weatherCutoff(
  constraintId: string,
  forbiddenConditions: WeatherCondition[],
  description = `weather cutoff ${constraintId}`,
): HardConstraint {
  return { rule: "weather-cutoff", constraintId, description, forbiddenConditions };
}

export function softWeight(constraintId: string, weight = 0.5): WeightedConstraint {
  return { constraintId, description: `soft constraint ${constraintId}`, weight };
}

export function tariffCurve(
  curveId = "curve-test",
  points?: EnergyCostCurve["points"],
): EnergyCostCurve {
  return {
    curveId,
    currency: "USD",
    points: points ?? [
      { at: "2026-11-02T00:00:00-08:00", pricePerKwh: 0.09 },
      { at: "2026-11-02T16:00:00-08:00", pricePerKwh: 0.28 },
    ],
  };
}

/** A valid, approved tariff pack; tests override the fields they care about. */
export function tariffPack(
  overrides: Partial<ExternalConstraintPack> = {},
): ExternalConstraintPack {
  const base: ExternalConstraintPack = {
    schemaVersion: "1.0.0",
    packId: "pack-tariff-test",
    source: "tariff",
    appliesTo: {},
    hard: [],
    soft: [],
    costTerms: [tariffCurve()],
    provenance: { origin: "test tariff sheet", humanApproved: true, extractedBy: "human" },
  };
  return { ...base, ...overrides };
}

export function versioned(
  pack: ExternalConstraintPack,
  effectiveFrom: string,
  effectiveUntil?: string,
): VersionedConstraintPack {
  return effectiveUntil === undefined
    ? { pack, effectiveFrom }
    : { pack, effectiveFrom, effectiveUntil };
}
