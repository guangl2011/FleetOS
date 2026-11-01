import type { EnergyCostCurve, ExternalConstraintPack, Robot } from "@fleetos/core-schema";
import { packAppliesTo } from "@fleetos/constraints";
import type { SelectorContext } from "@fleetos/constraints";

/**
 * Energy pricing and accounting for the constraint-pack cost axis (spec D1:
 * "the benchmark reports energy cost alongside completion and interventions").
 *
 * `priceAt` is a step function — tariffs are time-of-use blocks, not linear
 * ramps: the price in force at an instant is the last curve point at or
 * before it. Before the first point, the first price applies (flat
 * extrapolation), so a scenario day that starts before the curve's first
 * boundary is still priced.
 */

/** Price in $/kWh in force at `instantMs`. Curves are validated ascending at ingestion. */
export function priceAt(curve: EnergyCostCurve, instantMs: number): number {
  const points = curve.points;
  const first = points[0];
  if (first === undefined) {
    // Ingestion rejects empty curves; the guard keeps this total for tsc.
    throw new RangeError(`cost curve "${curve.curveId}" has no points`);
  }
  let price = first.pricePerKwh;
  for (const point of points) {
    if (Date.parse(point.at) <= instantMs) {
      price = point.pricePerKwh;
    } else {
      break;
    }
  }
  return price;
}

/**
 * Cost of drawing `powerKw` continuously from `startMs` to `endMs` under a
 * step-function price curve: segment-wise integration across the price
 * boundaries the interval covers.
 */
export function energyCost(
  curve: EnergyCostCurve,
  powerKw: number,
  startMs: number,
  endMs: number,
): number {
  if (endMs <= startMs) {
    return 0;
  }
  const boundaries = curve.points
    .map((point) => Date.parse(point.at))
    .filter((at) => at > startMs && at < endMs)
    .sort((a, b) => a - b);
  let cost = 0;
  let from = startMs;
  for (const boundary of [...boundaries, endMs]) {
    const hours = (boundary - from) / 3_600_000;
    cost += powerKw * hours * priceAt(curve, from);
    from = boundary;
  }
  return cost;
}

/**
 * The strongest applicable demand-side preference: pack soft constraints
 * scale the energy term they annotate (a 0.7 demand-charge-aversion weight
 * makes off-peak shifting worth 1.7x the raw price difference). Only packs
 * applying to the site/robot-kind context count.
 */
export function softWeightFactor(
  packs: readonly ExternalConstraintPack[],
  context: SelectorContext,
): number {
  let weight = 0;
  for (const pack of packs) {
    if (!packAppliesTo(pack, context)) {
      continue;
    }
    for (const soft of pack.soft) {
      weight = Math.max(weight, soft.weight);
    }
  }
  return 1 + weight;
}

/** The cost curves that apply to a context (a robot charging or working at a site). */
export function applicableCurves(
  packs: readonly ExternalConstraintPack[],
  context: SelectorContext,
): readonly EnergyCostCurve[] {
  return packs.filter((pack) => packAppliesTo(pack, context)).flatMap((pack) => pack.costTerms);
}

/** Work power in kW (capability physics: nominal draw). */
export function workPowerKw(robot: Robot): number {
  return robot.capabilities.nominalPowerWhPerHour / 1000;
}

/** Battery capacity in kWh. */
export function batteryKwh(robot: Robot): number {
  return robot.capabilities.batteryWh / 1000;
}

/** Charge power in kW: the worst-case side of chargeHours (10%→100%), matching the world model's conservative read. */
export function chargePowerKw(robot: Robot): number {
  return (0.9 * robot.capabilities.batteryWh) / robot.capabilities.chargeHours[1] / 1000;
}
