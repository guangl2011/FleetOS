import type { Robot } from "@fleetos/core-schema";

import { WorldModelError } from "./errors.js";
import type { FleetStateEstimate } from "./state.js";

/** Projected state of one robot at the prediction horizon. */
export interface PredictedRobotState {
  readonly robotId: string;
  /** Projected battery in [0, 100]; null when the shadow has no observation to project from. */
  readonly predictedBatteryPct: number | null;
  readonly predictedCharging: boolean | null;
  /** Projected task progress; v1 carries the last observation (see createDeterministicPredictor). */
  readonly predictedProgressPct: number | null;
  /** Estimate quality carried forward — the scheduler's down-weighting input. */
  readonly confidence: number;
}

/** The futures a consumer sees from FleetWorldModel.predict — predictor-agnostic by construction. */
export interface PredictedFutures {
  readonly predictorId: string;
  readonly generatedAt: string;
  readonly horizonMinutes: number;
  /** Sorted by robotId, mirroring the snapshot's deterministic order. */
  readonly robots: readonly PredictedRobotState[];
}

/** Everything a predictor may read: the shadow estimate, the registry, the ask. */
export interface PredictionContext {
  readonly now: string;
  readonly horizonMinutes: number;
  readonly fleet: FleetStateEstimate;
  /** Registry lookup: capability physics for the projection. */
  readonly robots: ReadonlyMap<string, Robot>;
}

/**
 * The prediction seam (spec D1 world-model). Consumers call
 * `FleetWorldModel.predict(horizonMinutes)` and receive PredictedFutures —
 * they never see the predictor's concrete type. The MVP ships the
 * deterministic closed-form projection; Phase I swaps in a learned predictor
 * behind this same interface — a falsifiable swap measured on the same
 * benchmark, without touching a consumer.
 */
export interface FleetPredictor {
  readonly id: string;
  predict(context: PredictionContext): PredictedFutures;
}

export const DETERMINISTIC_PREDICTOR_ID = "deterministic-v1";

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * The MVP predictor: closed-form battery projection from each robot's
 * capability physics, everything else carried forward from the last
 * observation. Deterministic by construction — no randomness, no wall clock
 * beyond the injected one.
 *
 * v1 modeling choices, stated plainly:
 * - Drain rate: nominalPowerWhPerHour / batteryWh of capacity per hour.
 * - Charge rate: the worst-case side of chargeHours (10%→100%) — risk-aware
 *   scheduling prefers conservative charge projections.
 * - Charging robots are assumed to stay docked over the horizon.
 * - Task progress is carried, not extrapolated: completion-time distributions
 *   need task geometry the shadow does not model yet — that enrichment is
 *   exactly the Phase I learned predictor's job.
 */
export function createDeterministicPredictor(): FleetPredictor {
  return {
    id: DETERMINISTIC_PREDICTOR_ID,
    predict(context: PredictionContext): PredictedFutures {
      const hours = context.horizonMinutes / 60;
      const robots = context.fleet.robots.map((slice) => {
        const robot = context.robots.get(slice.robotId);
        if (robot === undefined) {
          // The model builds the context from its own registry, so this is a
          // shape violation by the caller, not bad telemetry — surface it.
          throw new WorldModelError(
            "ROBOT_UNKNOWN",
            `predictor context references unregistered robot "${slice.robotId}"`,
          );
        }
        const { batteryWh, nominalPowerWhPerHour, chargeHours } = robot.capabilities;
        const chargePctPerHour = 90 / chargeHours[1];
        const drainPctPerHour = (nominalPowerWhPerHour / batteryWh) * 100;
        const predictedBatteryPct =
          slice.batteryPct === null
            ? null
            : clampPct(
                slice.charging
                  ? slice.batteryPct + chargePctPerHour * hours
                  : slice.batteryPct - drainPctPerHour * hours,
              );
        return {
          robotId: slice.robotId,
          predictedBatteryPct,
          predictedCharging: slice.charging,
          predictedProgressPct: slice.progressPct,
          confidence: slice.confidence,
        };
      });
      return {
        predictorId: DETERMINISTIC_PREDICTOR_ID,
        generatedAt: context.now,
        horizonMinutes: context.horizonMinutes,
        robots,
      };
    },
  };
}
