import type { Robot } from "@fleetos/core-schema";
import type { DigitalShadowSlice } from "@fleetos/world-model";

/**
 * Per-robot risk model — the planner's intervention-cost input (design doc
 * §7: "expected human interventions … using per-robot reliability learned
 * from the telemetry/fault stream").
 *
 * Every factor is named and documented so an operator can read why a number
 * moved; the weights are the MVP's calibrated judgment, live in one place,
 * and are exercised by the benchmark (the pass bars are what keep them
 * honest). All factors are deterministic functions of the world-model slice.
 */

/** Probability that one assignment ends in a human touch, in [0, 1]. */
export interface InterventionRiskInput {
  readonly robot: Robot;
  readonly slice: DigitalShadowSlice;
  /** Decision instant (epoch ms) — ages are measured from here. */
  readonly nowMs: number;
  /** Projected battery percent at task completion (after travel + work). */
  readonly endBatteryPct: number;
  /** The objective's reserve floor; margin below `floor + thinMarginPct` is risky. */
  readonly floorPct: number;
  /** Minutes of work planned — longer exposure raises surprise risk slightly. */
  readonly workMinutes: number;
}

/** Battery margin below which an assignment is treated as thin. */
export const THIN_MARGIN_PCT = 10;
/** Extra surprise probability per (1 − confidence), scaled by data quality. */
export const LOW_CONFIDENCE_FACTOR = 0.15;
/** Surprise probability added while any fault is active. */
export const ACTIVE_FAULT_RISK = 0.15;
/** Extra risk when the robot's last fault was recent (within one working day). */
export const RECENT_FAULT_RISK = 0.05;
/** Multiplier for a robot that cannot resume without an on-site human. */
export const NO_REMOTE_RESUME_MULTIPLIER = 1.5;
/** Surprise probability added per thin/below-floor battery margin point. */
export const THIN_MARGIN_FACTOR = 0.02;
/** Base per-assignment surprise probability with a healthy, fresh robot. */
export const BASE_INTERVENTION_RISK = 0.02;

/** Clamps to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Expected human interventions for one assignment. Mechanisms, in order of
 * weight: an active fault (the robot is already misbehaving), thin battery
 * margin at completion (a mid-field battery death always needs a human),
 * low data quality (surprises the plan did not model), and a recent fault
 * history. A robot that cannot remote-resume compounds every mechanism —
 * when it stops, a human goes on site.
 */
export function interventionRisk(input: InterventionRiskInput): number {
  const { robot, slice, nowMs, endBatteryPct, floorPct, workMinutes } = input;
  let risk = BASE_INTERVENTION_RISK;
  if (slice.activeFault !== null) {
    risk += ACTIVE_FAULT_RISK;
  } else if (slice.lastFault !== null) {
    const faultAgeMs = nowMs - Date.parse(slice.lastFault.ts);
    if (faultAgeMs <= 24 * 3_600_000) {
      risk += RECENT_FAULT_RISK;
    }
  }
  const margin = endBatteryPct - floorPct;
  if (margin < THIN_MARGIN_PCT) {
    risk += (THIN_MARGIN_PCT - margin) * THIN_MARGIN_FACTOR;
  }
  risk += (1 - slice.confidence) * LOW_CONFIDENCE_FACTOR;
  risk *= workMinutes > 0 ? 1 + workMinutes / (8 * 60) : 1;
  if (!robot.capabilities.remoteResume) {
    risk *= NO_REMOTE_RESUME_MULTIPLIER;
  }
  return clamp01(risk);
}

/**
 * Risk-inflated duration estimate: the nominal estimate stretched by the
 * planner's distrust of its own data. A low-confidence slice plans longer
 * durations, which both widens feasibility checks (work may run into a
 * forbidden window) and prices lateness honestly.
 */
export function inflatedDurationMinutes(estMinutes: number, confidence: number): number {
  const inflation = 1 + (1 - confidence) * DURATION_INFLATION_FACTOR;
  return estMinutes * inflation;
}

/** Duration stretch at zero confidence. */
export const DURATION_INFLATION_FACTOR = 0.5;
