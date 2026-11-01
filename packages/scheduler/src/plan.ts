import type { DispatchPlan, GeoPoint, Robot } from "@fleetos/core-schema";
import { DispatchPlanSchema } from "@fleetos/core-schema";
import type { DigitalShadowSlice, FleetStateEstimate } from "@fleetos/world-model";

import { SchedulerError } from "./errors.js";
import type { SchedulableTask } from "./input.js";

/**
 * The scheduler's output contract. `DispatchPlan` (core-schema) is the
 * operator-facing assignment plan; `charging` and `unassigned` are
 * scheduler-level extensions the landed DispatchPlan schema does not carry —
 * charge windows are the constraint-pack cost axis's lever (off-peak
 * shifting is measured on them), and unassigned tasks carry the reason a
 * plan left work unplanned (explainability, testing plan §2.6).
 */
export interface ChargeAssignment {
  readonly robotId: string;
  /** When to begin charging (RFC 3339). */
  readonly startAt: string;
  readonly estMinutes: number;
  /** Charge target in percent — the runtime stops charging here. */
  readonly targetBatteryPct: number;
  /** Explainability: why this charge window exists (and, when relevant, its price). */
  readonly reason: string;
}

export interface UnassignedTask {
  readonly taskId: string;
  /** Why the plan left this task unassigned (no robot feasible, window unfixable, …). */
  readonly reason: string;
}

/**
 * Task ids claimed in the shadow (some robot's `currentTaskId`). Both
 * schedulers filter these out before assignment — a task being worked is
 * not re-dispatched to a second robot, no matter how the greedy walk or the
 * candidate scoring sees the rest of the fleet.
 */
export function claimedTaskIds(estimate: FleetStateEstimate): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const slice of estimate.robots) {
    if (slice.currentTaskId !== null) {
      claimed.add(slice.currentTaskId);
    }
  }
  return claimed;
}

export interface SchedulerPlan {
  /** The core-schema dispatch plan — schema-validated before returning (see `assemblePlan`). */
  readonly plan: DispatchPlan;
  readonly charging: readonly ChargeAssignment[];
  readonly unassigned: readonly UnassignedTask[];
}

/**
 * Deterministic task ordering for the greedy walk: priority descending, then
 * earliest deadline, then taskId — the same order for every scheduler and
 * every replan, so comparisons never hinge on input ordering.
 */
export function orderTasks(tasks: readonly SchedulableTask[]): readonly SchedulableTask[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aEnd = Date.parse(a.window.notAfter);
    const bEnd = Date.parse(b.window.notAfter);
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}

export interface PlanProjections {
  readonly onTimeCompletion: number;
  readonly expectedInterventions: number;
  readonly minBatteryReservePct: number;
}

/**
 * Assembles the final SchedulerPlan and validates the embedded DispatchPlan
 * against the core schema — schema-validated at the boundary, like adapter
 * records. `plannerTag` namespaces plan ids per scheduler (the baseline and
 * the planner may plan the same instant; ids must not collide).
 */
export function assemblePlan(input: {
  readonly plannerTag: string;
  readonly createdAt: string;
  readonly assignments: DispatchPlan["assignments"];
  readonly projections: PlanProjections;
  readonly charging: readonly ChargeAssignment[];
  readonly unassigned: readonly UnassignedTask[];
}): SchedulerPlan {
  const plan: DispatchPlan = {
    schemaVersion: "1.0.0",
    planId: `plan-${input.plannerTag}-${input.createdAt}`,
    createdAt: input.createdAt,
    assignments: input.assignments,
    projected: {
      onTimeCompletion: input.projections.onTimeCompletion,
      expectedInterventions: input.projections.expectedInterventions,
      minBatteryReservePct: input.projections.minBatteryReservePct,
    },
  };
  const parsed = DispatchPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new SchedulerError(
      "INPUT_INVALID",
      `assembled plan failed DispatchPlan schema validation: ${parsed.error.message}`,
    );
  }
  return {
    plan: parsed.data,
    charging: input.charging,
    unassigned: input.unassigned,
  };
}

/** One planned occupation of a robot: a work stint or a charge stint. */
export interface PlannedOccupation {
  readonly startMs: number;
  readonly endMs: number;
  /** Battery-percent change over the occupation (work drains, charging gains). */
  readonly deltaPct: number;
}

/** Per-robot planning state carried across the greedy walk. */
export interface RobotPlanState {
  readonly robot: Robot;
  readonly slice: DigitalShadowSlice;
  /** Shadow battery percent at the planning instant. */
  batteryPct: number;
  /** When the robot is next free (epoch ms) — the baseline's dispatch cursor. */
  freeAtMs: number;
  /** Projected position: most recent known pose, updated to the committed task site. */
  pose: GeoPoint | null;
  /** Planned occupations. The planner packs disjoint intervals onto one robot
   *  (e.g. an early window task in front of a later high-priority claim)
   *  instead of serializing every assignment behind a single time cursor. */
  readonly busy: PlannedOccupation[];
}

/** Snapshot-instant projection state for one robot, before any assignments. */
export function initialRobotState(
  robot: Robot,
  slice: DigitalShadowSlice,
  nowMs: number,
  chargeRatePctPerHour: number,
): RobotPlanState {
  let freeAtMs = nowMs;
  const batteryPct = slice.batteryPct ?? 0;
  const busy: PlannedOccupation[] = [];
  if (slice.state === "charging" && slice.charging === true) {
    // Busy until topped up; the runtime stops charging at the plan's target.
    freeAtMs = nowMs + ((100 - (slice.batteryPct ?? 0)) / chargeRatePctPerHour) * 3_600_000;
    busy.push({ startMs: nowMs, endMs: freeAtMs, deltaPct: 100 - (slice.batteryPct ?? 0) });
  }
  return { robot, slice, batteryPct, freeAtMs, pose: slice.pose, busy };
}
