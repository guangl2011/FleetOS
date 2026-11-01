import { PercentSchema } from "@fleetos/core-schema";

import { SchedulerError } from "./errors.js";

/**
 * The joint objective every scheduler optimizes (design doc §7). All cost
 * terms are dollars; hard constraints (constraint-pack time windows and
 * weather cutoffs, battery floor) are feasibility gates outside this score.
 *
 * Constraint-pack soft costs enter separately: pack soft weights scale the
 * energy term, and pack cost curves price energy — see `energy.ts`.
 */
export interface SchedulingObjective {
  /** Penalty for completing a task off-time, scaled by how much of the window was missed. */
  readonly onTimeWeight: number;
  /** Battery reserve floor in percent — never dispatch a plan that lands below it. */
  readonly batteryReserveFloorPct: number;
  /** Cost of one robot-hour spent traveling between sites. */
  readonly travelCostPerHour: number;
  /** Cost of one expected human touch (the RaaS cost driver — docx §7). */
  readonly interventionCost: number;
  /**
   * Dollars-to-utility conversion for energy costs priced by pack cost curves.
   * Optional; defaults to `DEFAULT_ENERGY_COST_WEIGHT`.
   */
  readonly energyCostWeight?: number;
}

export const DEFAULT_ENERGY_COST_WEIGHT = 1;

/**
 * The planner's fully-resolved objective (optional fields defaulted).
 * `planSchedule` and `ruleBasedBaseline` both accept the partial form and
 * normalize internally, so presets can omit `energyCostWeight`.
 */
export type PartialSchedulingObjective = Partial<SchedulingObjective>;

export interface NormalizedObjective extends SchedulingObjective {
  readonly energyCostWeight: number;
}

/**
 * Money-scaled defaults: one expected human touch dwarfs an hour of travel,
 * and on-time completion is a service commitment, not a dollar line — the
 * 100× utility scale keeps it dominant. Scenarios pass explicit objectives;
 * these exist so partial objectives normalize deterministically.
 */
export const DEFAULT_OBJECTIVE: SchedulingObjective = {
  onTimeWeight: 100,
  batteryReserveFloorPct: 20,
  travelCostPerHour: 50,
  interventionCost: 500,
  energyCostWeight: DEFAULT_ENERGY_COST_WEIGHT,
};

/** Fills optional fields with defaults and refuses nonsense loudly. */
export function normalizeObjective(objective: PartialSchedulingObjective): NormalizedObjective {
  const merged: SchedulingObjective = {
    ...DEFAULT_OBJECTIVE,
    ...objective,
  };
  const normalized: NormalizedObjective = {
    onTimeWeight: merged.onTimeWeight,
    batteryReserveFloorPct: merged.batteryReserveFloorPct,
    travelCostPerHour: merged.travelCostPerHour,
    interventionCost: merged.interventionCost,
    energyCostWeight: merged.energyCostWeight ?? DEFAULT_ENERGY_COST_WEIGHT,
  };
  for (const key of [
    "onTimeWeight",
    "travelCostPerHour",
    "interventionCost",
    "energyCostWeight",
  ] as const) {
    const value = normalized[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new SchedulerError("OBJECTIVE_INVALID", `${key} must be a non-negative finite number`);
    }
  }
  const floor = normalized.batteryReserveFloorPct;
  if (!Number.isFinite(floor) || !PercentSchema.safeParse(floor).success) {
    throw new SchedulerError(
      "OBJECTIVE_INVALID",
      `batteryReserveFloorPct must be a percentage in [0, 100], got ${String(floor)}`,
    );
  }
  return normalized;
}
