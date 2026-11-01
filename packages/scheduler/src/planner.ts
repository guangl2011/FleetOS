import type { ExternalConstraintPack, Robot } from "@fleetos/core-schema";
import { ingestConstraintPacks } from "@fleetos/constraints";
import type { DigitalShadowSlice } from "@fleetos/world-model";

import {
  applicableCurves,
  chargePowerKw,
  energyCost,
  priceAt,
  softWeightFactor,
  workPowerKw,
} from "./energy.js";
import { SchedulerError } from "./errors.js";
import {
  applicableHardConstraints,
  intervalForbidden,
  intervalWeatherForbidden,
  robotServesTask,
} from "./feasibility.js";
import { distanceKm, resolveContext, sortedFleet } from "./input.js";
import type { SchedulableTask, SchedulingContext } from "./input.js";
import { normalizeObjective } from "./objective.js";
import type { NormalizedObjective, PartialSchedulingObjective } from "./objective.js";
import {
  assemblePlan,
  claimedTaskIds,
  initialRobotState,
  orderTasks,
  type PlannedOccupation,
  type RobotPlanState,
} from "./plan.js";
import type { ChargeAssignment, PlanProjections, SchedulerPlan, UnassignedTask } from "./plan.js";
import { inflatedDurationMinutes, interventionRisk, THIN_MARGIN_PCT } from "./risk.js";

/**
 * The risk-aware planner (spec D1): joint optimization of job completion,
 * battery reserve, travel, expected interventions, and constraint-pack
 * energy costs. Hard constraints — pack time windows, weather cutoffs, the
 * battery reserve floor, degraded-mode exclusion — are feasibility gates
 * outside the score; the objective ranks only what passes.
 *
 * The planner walks tasks greedily (priority desc → deadline asc → taskId)
 * and, per task, scans start slots across the whole SLA window per capable
 * robot — the slot scan is what makes off-peak shifting and weather avoidance
 * happen: a later start that dodges a price peak or a rain window wins when
 * the objective says so. Charging is inserted as first-class charge windows
 * (priced on the pack curves, placed at the cheapest feasible boundary).
 */

/** Dollars of cost per percent-point of thin battery margin at completion. */
const BATTERY_MARGIN_COST_PER_PCT = 0.5;
/** Margin (percent points above the floor's need) a charge insertion targets. */
const CHARGE_TARGET_MARGIN_PCT = 10;
/** Per-assignment cost floor constant so empty-cost candidates still rank stably. */
const EPSILON = 1e-9;

const RESERVE_FLOOR_BUFFER_PCT = 5;

interface ChargeWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly targetPct: number;
  readonly costUsd: number;
  readonly priceHint: number;
}

interface Candidate {
  readonly robotId: string;
  readonly taskId: string;
  readonly dispatchMs: number; // When the robot leaves (emitted as startAt).
  readonly workStartMs: number; // When work begins (dispatch + travel) — scoring only.
  readonly workEndMs: number;
  readonly estMinutes: number;
  readonly travelMinutes: number;
  readonly endBatteryPct: number;
  readonly cost: number;
  readonly pIntervention: number;
  readonly charge: ChargeWindow | null;
  /** Battery-percent drain of the work stint (travel excluded). */
  readonly workDrainPct: number;
  readonly riskNotes: readonly string[];
}

/** Battery percent consumed per hour of work at nominal power. */
function drainPctPerHour(robot: Robot): number {
  return (robot.capabilities.nominalPowerWhPerHour / robot.capabilities.batteryWh) * 100;
}

/** Battery percent gained per hour charging at the worst-case charge-hours rate. */
function chargePctPerHour(robot: Robot): number {
  return 90 / robot.capabilities.chargeHours[1];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Weighted hard gates for one task's work interval at a site. */
function workIntervalFeasible(input: {
  readonly context: ReturnType<typeof resolveContext>;
  readonly packs: readonly ExternalConstraintPack[];
  readonly robot: Robot;
  readonly siteId: string;
  readonly startMs: number;
  readonly endMs: number;
}): boolean {
  const { context, packs, robot, siteId, startMs, endMs } = input;
  const selector = { siteId, robotKind: robot.kind };
  for (const constraint of applicableHardConstraints(packs, selector)) {
    if (
      constraint.rule === "time-window" &&
      intervalForbidden(startMs, endMs, constraint.forbiddenWindows, context.localOffsetMinutes)
    ) {
      return false;
    }
    if (
      constraint.rule === "weather-cutoff" &&
      intervalWeatherForbidden(startMs, endMs, constraint.forbiddenConditions, context.weather)
    ) {
      return false;
    }
  }
  return true;
}

/** True iff [startMs, endMs) intersects any planned occupation. */
function overlapsBusy(busy: readonly PlannedOccupation[], startMs: number, endMs: number): boolean {
  return busy.some((occupation) => occupation.startMs < endMs && startMs < occupation.endMs);
}

/**
 * Shadow battery adjusted by every planned occupation that completes before
 * `atMs` — interval packing makes later-inserted earlier stints real, so the
 * battery available to a slot is the shadow value plus their net deltas.
 */
function projectedBatteryAt(state: RobotPlanState, atMs: number): number {
  let pct = state.batteryPct;
  for (const occupation of state.busy) {
    if (occupation.endMs <= atMs) {
      pct += occupation.deltaPct;
    }
  }
  return Math.min(100, Math.max(0, pct));
}

/** Cheapest feasible charge window for the needed top-up, at the given boundaries. */
function cheapestChargeWindow(input: {
  readonly packs: readonly ExternalConstraintPack[];
  readonly robot: Robot;
  readonly siteId: string;
  readonly freeAtMs: number;
  readonly latestEndMs: number;
  readonly chargeMinutes: number;
  readonly targetPct: number;
  readonly energyCostWeight: number;
  /** Planned occupations the charge window must not overlap. */
  readonly forbidden: readonly PlannedOccupation[];
}): ChargeWindow | null {
  const {
    packs,
    robot,
    siteId,
    freeAtMs,
    latestEndMs,
    chargeMinutes,
    targetPct,
    energyCostWeight,
    forbidden,
  } = input;
  const durationMs = chargeMinutes * 60_000;
  const latestStart = latestEndMs - durationMs;
  if (latestStart < freeAtMs) {
    return null;
  }
  const selector = { siteId, robotKind: robot.kind };
  const curves = applicableCurves(packs, selector);
  const factor = softWeightFactor(packs, selector) * energyCostWeight;
  const powerKw = chargePowerKw(robot);

  // Price is a step function: the optimal window start is at a curve boundary
  // or clamped to an edge of the feasible range. Enumerate exactly those.
  const starts = new Set<number>([freeAtMs, latestStart]);
  for (const curve of curves) {
    for (const point of curve.points) {
      const at = Date.parse(point.at);
      if (at >= freeAtMs && at <= latestStart) {
        starts.add(at);
      }
    }
  }
  let best: ChargeWindow | null = null;
  for (const startMs of [...starts].sort((a, b) => a - b)) {
    const endMs = startMs + durationMs;
    if (overlapsBusy(forbidden, startMs, endMs)) {
      continue; // Conflicts with another planned occupation of this robot.
    }
    let costUsd = 0;
    for (const curve of curves) {
      costUsd += energyCost(curve, powerKw, startMs, endMs) * factor;
    }
    const startPrice = curves.length > 0 ? priceAt(curves[0]!, startMs) : 0;
    if (best === null || costUsd < best.costUsd - EPSILON) {
      best = { startMs, endMs, targetPct, costUsd, priceHint: startPrice };
    }
  }
  return best;
}

interface EvaluateInput {
  readonly task: SchedulableTask;
  readonly state: RobotPlanState;
  readonly context: ReturnType<typeof resolveContext>;
  readonly packs: readonly ExternalConstraintPack[];
  readonly objective: NormalizedObjective;
  readonly nowMs: number;
  /** Wave-2 candidates may insert charge windows; wave-1 candidates may not. */
  readonly allowCharge: boolean;
}

/** Evaluates every start slot for one (task, robot) pair; returns the best candidate or null. */
function evaluateCandidate(input: EvaluateInput): Candidate | null {
  const { task, state, context, packs, objective, nowMs, allowCharge } = input;
  const { robot } = state;
  const slice = state.slice;
  const site = context.sites.get(task.siteId);
  if (site === undefined) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `task "${task.taskId}" references unknown site "${task.siteId}"`,
    );
  }

  const durMinutes = inflatedDurationMinutes(task.estMinutes, slice.confidence);
  const durMs = durMinutes * 60_000;
  const notBeforeMs = Date.parse(task.window.notBefore);
  const notAfterMs = Date.parse(task.window.notAfter);
  const windowMinutes = Math.max(1, (notAfterMs - notBeforeMs) / 60_000);

  const travelHours =
    state.pose === null ? 0 : distanceKm(state.pose, site) / context.travelSpeedKmh;
  const travelMs = travelHours * 3_600_000;
  const travelDrainPct = drainPctPerHour(robot) * context.travelDrainFactor * travelHours;

  // Dispatch-time slots: the emitted startAt is when the robot LEAVES; work
  // begins on arrival (dispatch + travel, which the runtime re-derives from
  // ground pose). Slots anchor to the minute grid at now (or the window open,
  // whichever is later) — anchoring at freeAt + travel instead makes the first
  // slot a moving target that outruns the horizon every cycle (the
  // commit-starvation bug). With the busy-interval model the slot walk skips
  // occupied stretches and finds the first genuinely free dispatch, so an
  // early-window task can pack in front of a later high-priority claim.
  const earliestDispatch = Math.ceil(Math.max(nowMs, notBeforeMs - travelMs) / 60_000) * 60_000;
  const latestDispatch = notAfterMs - durMs - travelMs;
  if (latestDispatch < earliestDispatch) {
    return null; // Window too tight even without risk inflation.
  }

  const stepMs = context.slotStepMinutes * 60_000;
  // Dispatch-slot enumeration: earliest feasible first; hard-capped for safety.
  // Only hard-feasible slots consume the cap — a long infeasible stretch (e.g.
  // a noise ordinance covering the first two hours of a task window) must not
  // exhaust the cap before the first legal slot is reached, or the task can
  // never be planned at all.
  const slots: { dispatchMs: number; workStartMs: number }[] = [];
  for (
    let dispatch = earliestDispatch;
    dispatch <= latestDispatch && slots.length < context.maxStartSlots;
    dispatch += stepMs
  ) {
    const workStartMs = dispatch + travelMs;
    if (overlapsBusy(state.busy, workStartMs, workStartMs + durMs)) {
      continue; // Occupied stretch — does not consume the feasible-slot cap.
    }
    if (
      !workIntervalFeasible({
        context,
        packs,
        robot,
        siteId: task.siteId,
        startMs: workStartMs,
        endMs: workStartMs + durMs,
      })
    ) {
      continue;
    }
    slots.push({ dispatchMs: dispatch, workStartMs });
  }

  let best: Candidate | null = null;
  for (const { dispatchMs, workStartMs } of slots) {
    const workEndMs = workStartMs + durMs;
    const batteryAtStart = projectedBatteryAt(state, workStartMs) - travelDrainPct;
    const endBatteryDirect = batteryAtStart - (durMinutes / 60) * drainPctPerHour(robot);
    const needAtStart =
      objective.batteryReserveFloorPct + (durMinutes / 60) * drainPctPerHour(robot);

    let charge: ChargeWindow | null = null;
    let endBatteryPct = endBatteryDirect;
    if (endBatteryDirect < objective.batteryReserveFloorPct) {
      if (!allowCharge) {
        continue; // Direct-battery wave: charge-requiring candidates wait for wave 2.
      }
      // Floor would be breached — insert a charge window before the work.
      const targetAtStart = Math.min(100, needAtStart + CHARGE_TARGET_MARGIN_PCT);
      const chargeMinutes = ((targetAtStart - batteryAtStart) / chargePctPerHour(robot)) * 60;
      if (chargeMinutes > 0) {
        const window2 = cheapestChargeWindow({
          packs,
          robot,
          siteId: task.siteId,
          freeAtMs: nowMs, // Busy-interval rejection keeps the window conflict-free.
          latestEndMs: dispatchMs, // Charge must end before the robot leaves.
          chargeMinutes,
          targetPct: targetAtStart,
          energyCostWeight: objective.energyCostWeight,
          forbidden: state.busy,
        });
        if (window2 === null) {
          continue; // Cannot charge in time — slot infeasible.
        }
        charge = window2;
        endBatteryPct =
          batteryAtStart +
          (chargeMinutes / 60) * chargePctPerHour(robot) -
          (durMinutes / 60) * drainPctPerHour(robot);
        if (endBatteryPct < objective.batteryReserveFloorPct - RESERVE_FLOOR_BUFFER_PCT) {
          continue;
        }
      } else {
        continue;
      }
    }

    // Energy: work draw plus (when inserted) charge draw, priced by pack curves.
    const selector = { siteId: task.siteId, robotKind: robot.kind };
    const factor = softWeightFactor(packs, selector) * objective.energyCostWeight;
    let energyUsd = 0;
    for (const curve of applicableCurves(packs, selector)) {
      energyUsd += energyCost(curve, workPowerKw(robot), workStartMs, workEndMs) * factor;
    }
    if (charge !== null) {
      energyUsd += charge.costUsd;
    }

    const lateMs = Math.max(0, workEndMs - notAfterMs);
    const lateMinutes = lateMs / 60_000;
    const onTimePenalty =
      lateMs > 0 ? objective.onTimeWeight * (1 + lateMinutes / windowMinutes) : 0;
    const reservePenalty =
      Math.max(0, objective.batteryReserveFloorPct + THIN_MARGIN_PCT - endBatteryPct) *
      BATTERY_MARGIN_COST_PER_PCT;
    const travelCost = objective.travelCostPerHour * travelHours;
    const pIntervention = interventionRisk({
      robot,
      slice,
      nowMs,
      endBatteryPct,
      floorPct: objective.batteryReserveFloorPct,
      workMinutes: durMinutes,
    });
    const interventionPenalty = objective.interventionCost * pIntervention;
    const cost = onTimePenalty + reservePenalty + travelCost + interventionPenalty + energyUsd;

    if (best !== null && cost >= best.cost - EPSILON) {
      continue;
    }
    best = {
      robotId: robot.robotId,
      taskId: task.taskId,
      dispatchMs,
      workStartMs,
      workEndMs,
      estMinutes: Math.round(durMinutes * 10) / 10,
      travelMinutes: Math.round((travelMs / 60_000) * 10) / 10,
      endBatteryPct,
      cost,
      pIntervention,
      charge,
      workDrainPct: (durMinutes / 60) * drainPctPerHour(robot),
      riskNotes: candidateRiskNotes({
        task,
        charge,
        endBatteryPct,
        floorPct: objective.batteryReserveFloorPct,
        slice,
        lateMinutes,
        travelMinutes: travelMs / 60_000,
        energyUsd,
        confidence: slice.confidence,
      }),
    };
  }
  return best;
}

/** Explainability strings for one candidate — plan decisions are readable, not just optimal (design doc §7). */
function candidateRiskNotes(input: {
  readonly task: SchedulableTask;
  readonly charge: ChargeWindow | null;
  readonly endBatteryPct: number;
  readonly floorPct: number;
  readonly slice: DigitalShadowSlice;
  readonly lateMinutes: number;
  readonly travelMinutes: number;
  readonly energyUsd: number;
  readonly confidence: number;
}): readonly string[] {
  const notes: string[] = [];
  if (input.charge !== null) {
    notes.push(
      `charge inserted ${iso(input.charge.startMs)}–${iso(input.charge.endMs)} to protect the ${input.floorPct}% reserve floor`,
    );
  }
  if (input.endBatteryPct < input.floorPct + THIN_MARGIN_PCT) {
    notes.push(
      `battery margin thin: projected ${input.endBatteryPct.toFixed(1)}% at completion (floor ${input.floorPct}%)`,
    );
  }
  if (input.lateMinutes > 0) {
    notes.push(`projected ${input.lateMinutes.toFixed(0)} min past the SLA window end`);
  }
  if (input.slice.activeFault !== null) {
    notes.push(`active ${input.slice.activeFault.type} fault on this robot — reliability reduced`);
  } else if (input.slice.lastFault !== null) {
    notes.push(`recent ${input.slice.lastFault.type} fault in this robot's history`);
  }
  if (input.confidence < 0.7) {
    notes.push(`low world-model confidence (${input.confidence.toFixed(2)}) — duration inflated`);
  }
  if (input.travelMinutes >= 1) {
    notes.push(`travel ${input.travelMinutes.toFixed(0)} min to site`);
  }
  if (input.energyUsd > 0) {
    notes.push(`energy cost $${input.energyUsd.toFixed(2)} under constraint-pack curves`);
  }
  return notes;
}

/**
 * The risk-aware planner. Same signature as `ruleBasedBaseline` (design doc
 * §7); constraint packs pass through the approval-gated ingestion seam first
 * — nothing unapproved or invalid reaches this optimizer.
 */
export function planSchedule(
  fleet: readonly Robot[],
  tasks: readonly SchedulableTask[],
  context: SchedulingContext,
  objective: PartialSchedulingObjective,
  constraintPacks: readonly ExternalConstraintPack[] = [],
): SchedulerPlan {
  const resolvedObjective = normalizeObjective(objective);
  const resolvedContext = resolveContext(context);
  // Ingestion is the approval/semantic/scope-feasibility gate (throws on any
  // unapproved or invalid pack). Scoping needs per-pack selectors, which the
  // ingested form flattens away, so reads below scope over the original pack
  // records via packAppliesTo — same packs that just passed the gate.
  ingestConstraintPacks(constraintPacks);

  const nowMs = Date.parse(context.estimate.at);
  const slices = new Map<string, DigitalShadowSlice>();
  for (const slice of context.estimate.robots) {
    slices.set(slice.robotId, slice);
  }

  // Degraded-mode exclusion: slices the planner cannot trust or use get no
  // work — unseen (no data ever), stale/unreachable (telemetry not trusted),
  // faulted (the fault must clear first), executing (already mid-task; the
  // rolling replan picks them up when their task completes). Degraded robots
  // stay schedulable but down-weighted: low confidence inflates duration and
  // the active-fault risk term prices their unreliability.
  const usable = (slice: DigitalShadowSlice): boolean =>
    slice.state === "idle" || slice.state === "charging" || slice.state === "degraded";

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

  // Two evaluation waves per replan. Wave 1 scores direct-battery candidates
  // only; wave 2 adds charge-inserting candidates for whatever is still
  // unassigned. Without the split, a high-priority future task's charge window
  // claims a robot hours ahead (claims hold the whole plan) and starves
  // lower-priority work that could run on that robot right now — present work
  // first, charging second. Off-peak pre-charging survives: genuinely idle
  // robots (no wave-1 assignment claims them) still get charge windows.
  const pending = orderTasks(tasks).filter((task) => !claimed.has(task.taskId));
  const planned = new Set<string>();
  for (const allowCharge of [false, true] as const) {
    for (const task of pending) {
      if (planned.has(task.taskId)) {
        continue;
      }
      let best: Candidate | null = null;
      for (const state of states.values()) {
        if (!robotServesTask(state.robot, task.requirements.taskTypes, true)) {
          continue;
        }
        const candidate = evaluateCandidate({
          task,
          state,
          context: resolvedContext,
          packs: constraintPacks,
          objective: resolvedObjective,
          nowMs,
          allowCharge,
        });
        if (candidate === null) {
          continue;
        }
        if (best === null || candidate.cost < best.cost - EPSILON) {
          best = candidate;
        }
      }
      if (best === null) {
        continue; // Retried in the next wave (or reported unassigned below).
      }
      planned.add(task.taskId);
      const state = states.get(best.robotId);
      if (state === undefined) {
        continue; // Unreachable: best came from states.
      }
      if (best.charge !== null) {
        charging.push({
          robotId: best.robotId,
          startAt: iso(best.charge.startMs),
          estMinutes: Math.round((best.charge.endMs - best.charge.startMs) / 60_000),
          targetBatteryPct: Math.round(best.charge.targetPct),
          reason: `reserve-floor protection before task ${best.taskId} (price hint $${best.charge.priceHint.toFixed(2)}/kWh)`,
        });
      }
      assignments.push({
        robotId: best.robotId,
        taskId: best.taskId,
        startAt: iso(best.dispatchMs),
        estMinutes: best.estMinutes,
        riskNotes: [...best.riskNotes],
      });
      expectedInterventions += best.pIntervention;
      minReserve = Math.min(minReserve, best.endBatteryPct);
      if (best.workEndMs <= Date.parse(task.window.notAfter)) {
        onTimeCount += 1;
      }
      // Commit: occupations enter the robot's interval list (an earlier-window
      // task assigned later still packs in front of this one), their battery
      // deltas land with them, and the cursor extends for sequential consumers.
      if (best.charge !== null) {
        const chargeGainPct =
          ((best.charge.endMs - best.charge.startMs) / 3_600_000) * chargePctPerHour(state.robot);
        state.busy.push({
          startMs: best.charge.startMs,
          endMs: best.charge.endMs,
          deltaPct: chargeGainPct,
        });
      }
      const workDrainPct = best.workDrainPct;
      state.busy.push({
        startMs: best.workStartMs,
        endMs: best.workEndMs,
        deltaPct: -workDrainPct,
      });
      state.freeAtMs = Math.max(state.freeAtMs, best.workEndMs);
      // batteryPct stays at the shadow value — busy deltas carry all changes
      // (mutating it here would double-count with projectedBatteryAt).
      state.pose = context.sites.get(task.siteId) ?? state.pose;
    }
  }
  for (const task of pending) {
    if (!planned.has(task.taskId)) {
      unassigned.push({
        taskId: task.taskId,
        reason:
          "no robot satisfied the joint gates (capability, degraded-mode exclusion, hard windows, weather cutoff, reserve floor, charge feasibility) across both evaluation waves",
      });
    }
  }

  const totalTasks = assignments.length + unassigned.length;
  const projections: PlanProjections = {
    onTimeCompletion: totalTasks === 0 ? 1 : onTimeCount / totalTasks,
    expectedInterventions,
    minBatteryReservePct: Number.isFinite(minReserve)
      ? Math.max(0, Math.round(minReserve * 10) / 10)
      : 0, // Schema floor; deaths measured at runtime.
  };
  return assemblePlan({
    plannerTag: "risk-aware",
    createdAt: context.estimate.at,
    assignments,
    projections,
    charging,
    unassigned,
  });
}
