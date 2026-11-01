import type { ExternalConstraintPack, Robot } from "@fleetos/core-schema";
import { ingestConstraintPacks } from "@fleetos/constraints";
import type { DigitalShadowSlice } from "@fleetos/world-model";

import {
  applicableHardConstraints,
  intervalForbidden,
  intervalWeatherForbidden,
  robotServesTask,
} from "./feasibility.js";
import { distanceKm, resolveContext, sortedFleet } from "./input.js";
import type { SchedulableTask, SchedulingContext } from "./input.js";
import { SchedulerError } from "./errors.js";
import { normalizeObjective } from "./objective.js";
import type { PartialSchedulingObjective } from "./objective.js";
import { assemblePlan, claimedTaskIds, initialRobotState, orderTasks } from "./plan.js";
import type {
  ChargeAssignment,
  PlanProjections,
  RobotPlanState,
  SchedulerPlan,
  UnassignedTask,
} from "./plan.js";
import { interventionRisk } from "./risk.js";

/**
 * The rule-based baseline the risk-aware planner is benchmarked against
 * (spec D1, docx §7): nearest available robot, fixed battery threshold,
 * immediate dispatch. It applies the same hard-constraint gates (a noise
 * ordinance violation is illegal for any scheduler) but searches no slots,
 * plans no margins, pre-charges for nothing, and reads no prices — the
 * dispatch dashboard logic a mixed-fleet operator without an optimizer would run.
 *
 * Deliberate naiveties (these are the mechanisms the benchmark measures):
 * - dispatch-time battery check only — a robot just over the threshold takes
 *   a long task and dies mid-field (BATTERY fault, human retrieval);
 * - last-known-state dispatch — data staleness and confidence are ignored,
 *   so connectivity degradation produces assignments on stale belief;
 * - reactive charging only — charge when below threshold + hysteresis,
 *   never pre-emptively, never off-peak.
 */

/** Battery hysteresis above the floor for the baseline's reactive charging. */
export const BASELINE_CHARGE_HYSTERESIS_PCT = 5;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Battery percent consumed per hour of work at nominal power. */
function drainPctPerHour(robot: Robot): number {
  return (robot.capabilities.nominalPowerWhPerHour / robot.capabilities.batteryWh) * 100;
}

/** Battery percent gained per hour charging at the worst-case charge-hours rate. */
function chargePctPerHour(robot: Robot): number {
  return 90 / robot.capabilities.chargeHours[1];
}

/**
 * The rule-based baseline. Same signature as `planSchedule` (design doc §7).
 */
export function ruleBasedBaseline(
  fleet: readonly Robot[],
  tasks: readonly SchedulableTask[],
  context: SchedulingContext,
  objective: PartialSchedulingObjective,
  constraintPacks: readonly ExternalConstraintPack[] = [],
): SchedulerPlan {
  const resolvedObjective = normalizeObjective(objective);
  const resolvedContext = resolveContext(context);
  // Same ingestion gate as the planner: hard constraints apply to every
  // scheduler; only the optimization on top differs.
  ingestConstraintPacks(constraintPacks);

  const nowMs = Date.parse(context.estimate.at);
  const slices = new Map<string, DigitalShadowSlice>();
  for (const slice of context.estimate.robots) {
    slices.set(slice.robotId, slice);
  }

  // Last-known-state availability: the baseline trusts whatever the last
  // observation said — stale, unreachable, and degraded robots look usable
  // (it does not model data quality at all). Faulted robots are visibly
  // faulted even on a dashboard, executing robots visibly busy, charging
  // robots get reactive charge continuations.
  const usable = (slice: DigitalShadowSlice): boolean =>
    slice.state === "idle" ||
    slice.state === "stale" ||
    slice.state === "unreachable" ||
    slice.state === "degraded";

  const states = new Map<string, RobotPlanState>();
  for (const robot of sortedFleet(fleet)) {
    const slice = slices.get(robot.robotId);
    if (slice === undefined || !usable(slice)) {
      continue;
    }
    states.set(robot.robotId, initialRobotState(robot, slice, nowMs, chargePctPerHour(robot)));
  }

  const assignments: SchedulerPlan["plan"]["assignments"] = [];
  const charging: ChargeAssignment[] = [];
  const unassigned: UnassignedTask[] = [];
  const claimed = claimedTaskIds(context.estimate);
  let expectedInterventions = 0;
  let minReserve = Number.POSITIVE_INFINITY;
  let onTimeCount = 0;

  // Reactive charging pass first: any idle robot below threshold + hysteresis
  // charges now (and stays out of the work assignment pass this tick).
  const chargingNow = new Set<string>();
  for (const [robotId, state] of states) {
    const threshold = resolvedObjective.batteryReserveFloorPct + BASELINE_CHARGE_HYSTERESIS_PCT;
    if (state.batteryPct >= threshold) {
      continue;
    }
    const chargeMinutes = ((threshold - state.batteryPct) / chargePctPerHour(state.robot)) * 60;
    if (chargeMinutes <= 0) {
      continue;
    }
    chargingNow.add(robotId);
    charging.push({
      robotId,
      startAt: iso(nowMs),
      estMinutes: Math.ceil(chargeMinutes),
      targetBatteryPct: Math.round(threshold),
      reason: `battery ${state.batteryPct.toFixed(0)}% below fixed threshold ${resolvedObjective.batteryReserveFloorPct}% (+hysteresis)`,
    });
  }

  for (const task of orderTasks(tasks)) {
    if (claimed.has(task.taskId)) {
      continue; // Already being worked per the shadow — never re-dispatch.
    }
    const site = resolvedContext.sites.get(task.siteId);
    if (site === undefined) {
      throw new SchedulerError(
        "CONTEXT_INVALID",
        `task "${task.taskId}" references unknown site "${task.siteId}"`,
      );
    }
    let best: {
      state: RobotPlanState;
      dispatchMs: number;
      workStartMs: number;
      travelMinutes: number;
      endBatteryPct: number;
    } | null = null;
    for (const state of states.values()) {
      if (chargingNow.has(state.robot.robotId)) {
        continue;
      }
      if (!robotServesTask(state.robot, task.requirements.taskTypes, false)) {
        continue;
      }
      const travelHours =
        state.pose === null ? 0 : distanceKm(state.pose, site) / resolvedContext.travelSpeedKmh;
      const travelMs = travelHours * 3_600_000;
      // Dispatch-time semantics (same as the planner): the emitted startAt is
      // when the robot leaves; work begins on arrival (dispatch + travel).
      // Dispatch quantizes up to the minute so the runtime's replan horizon
      // can catch it — a moving now+travel anchor outruns the horizon every
      // cycle and starves the commit gate forever.
      const rawDispatchMs = Math.max(state.freeAtMs, Date.parse(task.window.notBefore) - travelMs);
      const dispatchMs = Math.ceil(rawDispatchMs / 60_000) * 60_000;
      const workStartMs = dispatchMs + travelMs;
      const workEndMs = workStartMs + task.estMinutes * 60_000;

      // Hard-constraint gates — identical to the planner's (illegality is not
      // a scheduling preference). Infeasible → robot skipped for this task.
      let forbidden = false;
      for (const constraint of applicableHardConstraints(constraintPacks, {
        siteId: task.siteId,
        robotKind: state.robot.kind,
      })) {
        if (
          constraint.rule === "time-window" &&
          intervalForbidden(
            workStartMs,
            workEndMs,
            constraint.forbiddenWindows,
            resolvedContext.localOffsetMinutes,
          )
        ) {
          forbidden = true;
          break;
        }
        if (
          constraint.rule === "weather-cutoff" &&
          intervalWeatherForbidden(
            workStartMs,
            workEndMs,
            constraint.forbiddenConditions,
            resolvedContext.weather,
          )
        ) {
          forbidden = true;
          break;
        }
      }
      if (forbidden) {
        continue;
      }

      // Fixed battery threshold at dispatch time only — no projected-end
      // check, no margin, no pre-charge. This is the death mechanism.
      if (state.batteryPct < resolvedObjective.batteryReserveFloorPct) {
        continue;
      }
      const endBatteryPct =
        state.batteryPct -
        drainPctPerHour(state.robot) * resolvedContext.travelDrainFactor * travelHours -
        drainPctPerHour(state.robot) * (task.estMinutes / 60);

      const travelMinutes = travelMs / 60_000;
      if (best === null || travelMinutes < best.travelMinutes) {
        best = { state, dispatchMs, workStartMs, travelMinutes, endBatteryPct };
      }
      // Ties prefer the earlier robotId — iteration order is sortedFleet().
    }
    if (best === null) {
      unassigned.push({
        taskId: task.taskId,
        reason:
          "no available robot passed the fixed battery threshold and hard windows at this instant",
      });
      continue;
    }
    const pIntervention = interventionRisk({
      robot: best.state.robot,
      slice: best.state.slice,
      nowMs,
      endBatteryPct: best.endBatteryPct,
      floorPct: resolvedObjective.batteryReserveFloorPct,
      workMinutes: task.estMinutes,
    });
    assignments.push({
      robotId: best.state.robot.robotId,
      taskId: task.taskId,
      startAt: iso(best.dispatchMs),
      estMinutes: task.estMinutes,
      riskNotes: [
        `nearest-available rule; dispatch battery ${best.state.batteryPct.toFixed(0)}% vs fixed threshold ${resolvedObjective.batteryReserveFloorPct}%`,
      ],
    });
    expectedInterventions += pIntervention;
    minReserve = Math.min(minReserve, best.endBatteryPct);
    if (best.workStartMs + task.estMinutes * 60_000 <= Date.parse(task.window.notAfter)) {
      onTimeCount += 1;
    }
    best.state.freeAtMs = best.workStartMs + task.estMinutes * 60_000;
    best.state.batteryPct = best.endBatteryPct;
    best.state.pose = site;
  }

  const totalTasks = assignments.length + unassigned.length;
  const projections: PlanProjections = {
    onTimeCompletion: totalTasks === 0 ? 1 : onTimeCount / totalTasks,
    expectedInterventions,
    // Clamped at 0: the schema floor. A plan that drives a battery below zero
    // is exactly the plan the runtime will punish with a mid-field death —
    // the projection reports 0 (floor breached), the runtime measures the rest.
    minBatteryReservePct: Number.isFinite(minReserve)
      ? Math.max(0, Math.round(minReserve * 10) / 10)
      : 0,
  };
  return assemblePlan({
    plannerTag: "baseline",
    createdAt: context.estimate.at,
    assignments,
    projections,
    charging,
    unassigned,
  });
}
