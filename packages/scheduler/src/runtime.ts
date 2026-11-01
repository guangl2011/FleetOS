import type {
  ExternalConstraintPack,
  FaultEvent,
  FaultType,
  GeoPoint,
  Robot,
  TelemetrySample,
} from "@fleetos/core-schema";
import { packAppliesTo } from "@fleetos/constraints";
import { createWorldModel } from "@fleetos/world-model";
import type { FleetWorldModel, WorldClock } from "@fleetos/world-model";

import { applicableCurves, chargePowerKw, energyCost, workPowerKw } from "./energy.js";
import { SchedulerError } from "./errors.js";
import { conditionAt, distanceKm } from "./input.js";
import { intervalForbidden } from "./feasibility.js";
import {
  DEFAULT_MAX_START_SLOTS,
  DEFAULT_SLOT_STEP_MINUTES,
  DEFAULT_TRAVEL_DRAIN_FACTOR,
  DEFAULT_TRAVEL_SPEED_KMH,
} from "./input.js";
import type { PartialSchedulingObjective } from "./objective.js";
import type { SchedulableTask, SchedulingContext } from "./input.js";
import type { SchedulerPlan } from "./plan.js";
import { planSchedule } from "./planner.js";
import { ruleBasedBaseline } from "./baseline.js";

/**
 * The deterministic fleet runtime (spec D1 benchmark harness): executes a
 * scheduler's plans against ground-truth robot physics while the world model
 * — the scheduler's only input — sees just the telemetry that survives the
 * scenario's connectivity windows. Both schedulers run through this exact
 * loop with identical scenarios; only the planning function differs.
 *
 * Determinism: no randomness anywhere. A scenario's randomness lives in its
 * explicit fault injections and connectivity windows; physics is a closed
 * model (linear battery drain, worst-case charge rate, haversine travel).
 * The seed rides along as scenario identity for reports and future
 * stochastic extensions — execution itself needs no RNG.
 */

/** One seeded fault: fires at `ts`, pauses the robot until `durationMinutes` elapses. Scenario authors should inject recovery-class faults (STUCK, BATTERY, SENSOR_DEGRADED) on working robots — the shadow clears them on progress evidence, which only working provides. */
export interface FaultInjection {
  readonly robotId: string;
  readonly ts: string;
  readonly type: Extract<
    FaultType,
    "BATTERY" | "STUCK" | "SENSOR_DEGRADED" | "COMMS_LOST" | "WEATHER_HOLD" | "MAINTENANCE_DUE"
  >;
  readonly durationMinutes: number;
}

/** A telemetry blackout: the robot keeps working but the shadow stops hearing from it. */
export interface ConnectivityWindow {
  readonly robotId: string;
  readonly from: string;
  readonly until: string;
}

export interface SimulationScenario {
  readonly scenarioId: string;
  readonly seed: number;
  /** RFC 3339 instant the horizon starts at. */
  readonly start: string;
  readonly horizonMinutes: number;
  readonly fleet: readonly Robot[];
  readonly tasks: readonly SchedulableTask[];
  readonly sites: ReadonlyMap<string, GeoPoint>;
  /** Scenario timezone offset in minutes (constraint windows are local-clock). */
  readonly localOffsetMinutes: number;
  readonly weather?: readonly {
    readonly from: string;
    readonly condition: "clear" | "light-rain" | "wet-grass";
  }[];
  readonly faultInjections: readonly FaultInjection[];
  readonly connectivityWindows: readonly ConnectivityWindow[];
  readonly packs: readonly ExternalConstraintPack[];
  /** All robots start here, fully charged. */
  readonly homeSiteId: string;
  readonly objective: PartialSchedulingObjective;
  /** Physics overrides (same defaults as the planner's context). */
  readonly travelSpeedKmh?: number;
  readonly travelDrainFactor?: number;
  readonly tickMinutes?: number;
  readonly replanIntervalMinutes?: number;
}

/** A scheduling function: planSchedule and ruleBasedBaseline both fit. */
export type SchedulerFn = (
  fleet: readonly Robot[],
  tasks: readonly SchedulableTask[],
  context: SchedulingContext,
  objective: PartialSchedulingObjective,
  constraintPacks: readonly ExternalConstraintPack[],
) => SchedulerPlan;

/** Measured results of one scheduler run over one scenario. */
export interface ChargingInterval {
  readonly robotId: string;
  readonly from: string;
  readonly until: string;
  readonly kwh: number;
}

/** One coalesced work (task execution) interval — the energy-shifting evidence. */
export interface WorkInterval {
  readonly robotId: string;
  readonly taskId: string;
  readonly from: string;
  readonly until: string;
  readonly kwh: number;
}

/** End-of-run disposition of one task. */
export interface TaskOutcome {
  readonly taskId: string;
  readonly status: "completed" | "incomplete";
  readonly attempts: number;
  readonly completedAt: string | null;
  readonly onTime: boolean;
}

export interface RunMetrics {
  readonly schedulerTag: string;
  readonly scenarioId: string;
  readonly seed: number;
  /** Per-task end state — the report's explainability layer (why a task didn't complete). */
  readonly taskOutcomes: readonly TaskOutcome[];
  readonly tasksTotal: number;
  readonly tasksCompleted: number;
  readonly tasksOnTime: number;
  /** Completed-within-SLA fraction over ALL tasks (uncompleted counts against). */
  readonly onTimeCompletion: number;
  readonly interventions: number;
  readonly robotHours: number;
  readonly interventionsPer100RobotHours: number;
  readonly energyKwh: number;
  readonly energyCostUsd: number;
  /** Hard-window violations must be 0 for every scheduler — asserted in tests. */
  readonly hardWindowViolations: number;
  readonly plansGenerated: number;
  readonly unassignedTaskEvents: number;
  readonly batteryDeaths: number;
  /** Coalesced charging intervals — the off-peak-shifting evidence. */
  readonly chargingIntervals: readonly ChargingInterval[];
  /** Coalesced execution intervals per (robot, task). */
  readonly workIntervals: readonly WorkInterval[];
}

interface GroundTruthRobot {
  readonly robot: Robot;
  batteryPct: number;
  pose: GeoPoint;
  siteId: string;
  mode: "idle" | "traveling" | "executing" | "charging" | "faulted";
  currentTaskId: string | null;
  /** When the robot arrives at the task site and work begins. */
  arriveAtMs: number | null;
  /** When the current work completes. */
  workEndMs: number | null;
  chargeTargetPct: number | null;
  /** Injected fault clears here; null when not faulted. */
  faultUntilMs: number | null;
  activeFault: FaultEvent | null;
  /** Telemetry suppressed while inside a connectivity window. */
  commsBlockedUntilMs: number | null;
  /** Claimed dispatch time: the robot departs at this moment (claim-early, depart-on-time). */
  pendingDispatchAtMs: number | null;
  /** Task bound to the pending claim (separate from the active job). */
  pendingTaskId: string | null;
}

interface TaskState {
  readonly task: SchedulableTask;
  completedAtMs: number | null;
  onTime: boolean;
  attempts: number;
  /** Ground-truth claim: exactly one robot owns a task from commit to completion/death. */
  assignedRobotId: string | null;
}

const DEFAULT_TICK_MINUTES = 1;
const DEFAULT_REPLAN_INTERVAL_MINUTES = 5;

function faultSeverity(type: FaultType): FaultEvent["severity"] {
  switch (type) {
    case "BATTERY":
    case "STUCK":
    case "COMMS_LOST":
      return "critical";
    case "SENSOR_DEGRADED":
      return "warning";
    default:
      return "info";
  }
}

/** A human touch is needed for mobility deaths, recovery-class faults, and robots that cannot remote-resume. */
function needsHumanTouch(type: FaultType, robot: Robot): boolean {
  return type === "BATTERY" || type === "STUCK" || !robot.capabilities.remoteResume;
}

/** Battery percent consumed per hour of work at nominal power. */
function drainPctPerHour(robot: Robot): number {
  return (robot.capabilities.nominalPowerWhPerHour / robot.capabilities.batteryWh) * 100;
}

/** Battery percent gained per hour at the worst-case charge-hours rate. */
function chargePctPerHour(robot: Robot): number {
  return 90 / robot.capabilities.chargeHours[1];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Runs one scheduler over one scenario to horizon end. The scheduler
 * function is the only difference between runs — identical fleet, tasks,
 * packs, faults, connectivity, and physics.
 */
export function runSimulation(scenario: SimulationScenario, scheduler: SchedulerFn): RunMetrics {
  const resolved = {
    travelSpeedKmh: scenario.travelSpeedKmh ?? DEFAULT_TRAVEL_SPEED_KMH,
    travelDrainFactor: scenario.travelDrainFactor ?? DEFAULT_TRAVEL_DRAIN_FACTOR,
    tickMinutes: scenario.tickMinutes ?? DEFAULT_TICK_MINUTES,
    replanIntervalMinutes: scenario.replanIntervalMinutes ?? DEFAULT_REPLAN_INTERVAL_MINUTES,
    maxStartSlots: DEFAULT_MAX_START_SLOTS,
    slotStepMinutes: DEFAULT_SLOT_STEP_MINUTES,
  };
  if (!Number.isInteger(resolved.tickMinutes) || resolved.tickMinutes <= 0) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `tickMinutes must be a positive integer, got ${String(resolved.tickMinutes)}`,
    );
  }
  if (!Number.isInteger(resolved.replanIntervalMinutes) || resolved.replanIntervalMinutes <= 0) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `replanIntervalMinutes must be a positive integer, got ${String(resolved.replanIntervalMinutes)}`,
    );
  }
  const home = scenario.sites.get(scenario.homeSiteId);
  if (home === undefined) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `home site "${scenario.homeSiteId}" is not in the scenario sites`,
    );
  }

  const startMs = Date.parse(scenario.start);
  const horizonMs = scenario.horizonMinutes * 60_000;
  const tickMs = resolved.tickMinutes * 60_000;
  const endMs = startMs + horizonMs;

  // Manual clock drives the world model's snapshot instant.
  let nowMs = startMs;
  const clock: WorldClock = { now: () => iso(nowMs) };
  const world: FleetWorldModel = createWorldModel({
    robots: scenario.fleet,
    clock,
    constraintPacks: (instant: string) => {
      void instant; // Packs are static in MVP scenarios; versioned libraries wire in later.
      return scenario.packs;
    },
  });

  const ground = new Map<string, GroundTruthRobot>();
  for (const robot of scenario.fleet) {
    ground.set(robot.robotId, {
      robot,
      batteryPct: 100,
      pose: home,
      siteId: scenario.homeSiteId,
      mode: "idle",
      currentTaskId: null,
      pendingDispatchAtMs: null,
      pendingTaskId: null,
      arriveAtMs: null,
      workEndMs: null,
      chargeTargetPct: null,
      faultUntilMs: null,
      activeFault: null,
      commsBlockedUntilMs: null,
    });
  }

  const taskStates = new Map<string, TaskState>();
  for (const task of scenario.tasks) {
    taskStates.set(task.taskId, {
      task,
      completedAtMs: null,
      onTime: false,
      attempts: 0,
      assignedRobotId: null,
    });
  }

  const connectivityByRobot = new Map<string, readonly ConnectivityWindow[]>();
  for (const window of scenario.connectivityWindows) {
    const existing = connectivityByRobot.get(window.robotId) ?? [];
    connectivityByRobot.set(window.robotId, [...existing, window]);
  }
  const telemetryBlockedAt = (robotId: string, atMs: number): boolean => {
    const windows = connectivityByRobot.get(robotId);
    if (windows === undefined) {
      return false;
    }
    return windows.some((w) => Date.parse(w.from) <= atMs && atMs < Date.parse(w.until));
  };

  const metrics = {
    interventions: 0,
    energyKwh: 0,
    energyCostUsd: 0,
    hardWindowViolations: 0,
    plansGenerated: 0,
    unassignedTaskEvents: 0,
    batteryDeaths: 0,
  };

  // Interval coalescing: consecutive charging/execution ticks merge into one
  // interval with summed kWh — the benchmark's off-peak-shifting evidence.
  const openCharging = new Map<string, { startMs: number; kwh: number }>();
  const chargingIntervals: ChargingInterval[] = [];
  const openWork = new Map<string, { taskId: string; startMs: number; kwh: number }>();
  const workIntervals: WorkInterval[] = [];
  const closeCharging = (robotId: string, atMs: number): void => {
    const open = openCharging.get(robotId);
    if (open === undefined) {
      return;
    }
    openCharging.delete(robotId);
    if (open.kwh > 0) {
      chargingIntervals.push({
        robotId,
        from: iso(open.startMs),
        until: iso(atMs),
        kwh: Math.round(open.kwh * 1000) / 1000,
      });
    }
  };
  const closeWork = (robotId: string, atMs: number): void => {
    const open = openWork.get(robotId);
    if (open === undefined) {
      return;
    }
    openWork.delete(robotId);
    if (open.kwh > 0) {
      workIntervals.push({
        robotId,
        taskId: open.taskId,
        from: iso(open.startMs),
        until: iso(atMs),
        kwh: Math.round(open.kwh * 1000) / 1000,
      });
    }
  };

  /** Energy $/kWh curves in force for a site/robot-kind — first curve prices the measured cost. */
  const priceCurve = (siteId: string, robotKind: Robot["kind"]) => {
    const curves = applicableCurves(scenario.packs, { siteId, robotKind });
    return curves[0] ?? null;
  };
  const accumulateEnergy = (
    siteId: string,
    robotKind: Robot["kind"],
    powerKw: number,
    fromMs: number,
    toMs: number,
  ): void => {
    const curve = priceCurve(siteId, robotKind);
    if (curve === null || toMs <= fromMs) {
      return;
    }
    metrics.energyKwh += powerKw * ((toMs - fromMs) / 3_600_000);
    metrics.energyCostUsd += energyCost(curve, powerKw, fromMs, toMs);
  };

  const emitTelemetry = (state: GroundTruthRobot, ts: string): void => {
    if (state.commsBlockedUntilMs !== null && nowMs < state.commsBlockedUntilMs) {
      return; // Connectivity window: the shadow hears nothing.
    }
    let progressPct: number | undefined;
    if (state.mode === "executing" && state.currentTaskId !== null && state.workEndMs !== null) {
      const taskState = taskStates.get(state.currentTaskId);
      if (taskState !== undefined) {
        const totalMs = taskState.task.estMinutes * 60_000;
        // Progress over the ORIGINAL work interval; pauses (faults) shift
        // workEndMs, so progress may exceed the naive fraction — clamp at 100.
        const elapsed = 1 - (state.workEndMs - nowMs) / totalMs;
        progressPct = Math.min(100, Math.max(0, Math.round(elapsed * 10000) / 100));
      }
    }
    const sample: TelemetrySample = {
      robotId: state.robot.robotId,
      ts,
      batteryPct: Math.max(0, Math.round(state.batteryPct * 100) / 100),
      charging: state.mode === "charging",
      pose: { lat: state.pose.lat, lon: state.pose.lon },
      ...(progressPct === undefined ? {} : { progressPct }),
    };
    world.ingest(sample);
  };

  const raiseFault = (state: GroundTruthRobot, injection: FaultInjection, atMs: number): void => {
    if (state.faultUntilMs !== null) {
      return; // Already faulted — a second injection inside the window is a no-op.
    }
    const event: FaultEvent = {
      faultId: `fault-${state.robot.robotId}-${injection.type}-${atMs}`,
      robotId: state.robot.robotId,
      ts: iso(atMs),
      type: injection.type,
      severity: faultSeverity(injection.type),
      message: `${injection.type} fault injected at ${iso(atMs)} for ${injection.durationMinutes} min`,
    };
    state.faultUntilMs = atMs + injection.durationMinutes * 60_000;
    state.activeFault = event;
    state.mode = "faulted";
    if (injection.type === "COMMS_LOST") {
      state.commsBlockedUntilMs = state.faultUntilMs;
    }
    world.ingest(event);
    if (needsHumanTouch(injection.type, state.robot)) {
      metrics.interventions += 1;
    }
  };

  const killTaskBatteryDeath = (state: GroundTruthRobot, atMs: number): void => {
    // Mid-field battery death: task abandoned, human retrieves to the dock,
    // the robot charges there. The claim is released so the task can be
    // re-dispatched (bounded by the attempts cap in the pending filter).
    metrics.batteryDeaths += 1;
    metrics.interventions += 1;
    if (state.currentTaskId !== null) {
      const abandoned = taskStates.get(state.currentTaskId);
      if (abandoned !== undefined) {
        abandoned.assignedRobotId = null;
      }
      world.assignTask(state.robot.robotId, null);
    }
    state.currentTaskId = null;
    state.pendingDispatchAtMs = null;
    state.pendingTaskId = null;
    state.arriveAtMs = null;
    state.workEndMs = null;
    state.batteryPct = 0;
    state.pose = home;
    state.siteId = scenario.homeSiteId;
    world.assignSite(state.robot.robotId, scenario.homeSiteId);
    const event: FaultEvent = {
      faultId: `fault-${state.robot.robotId}-BATTERY-${atMs}`,
      robotId: state.robot.robotId,
      ts: iso(atMs),
      type: "BATTERY",
      severity: "critical",
      message: "battery exhausted mid-task; human retrieval to dock",
    };
    state.mode = "charging"; // The human left it on the charger.
    state.chargeTargetPct = 100;
    world.ingest(event);
  };

  const COMMIT_AHEAD_MS = 60 * 60_000;
  const commitPlan = (plan: SchedulerPlan, comingUntilMs: number): void => {
    for (const charge of plan.charging) {
      const state = ground.get(charge.robotId);
      if (state === undefined) {
        continue;
      }
      const startMs2 = Date.parse(charge.startAt);
      // Commit anything that lands by the next replan plus one tick. Starts
      // carry travel remainders (sub-minute seconds), so a strict horizon
      // would drop a start that falls 38s past the boundary — and re-plan it
      // into the same relative position forever (commit starvation).
      if (startMs2 > comingUntilMs + tickMs) {
        continue;
      }
      if (state.mode === "faulted" || state.mode === "traveling" || state.mode === "executing") {
        continue;
      }
      if (state.mode === "charging") {
        continue; // Already charging; the target check below ends it.
      }
      state.mode = "charging";
      state.chargeTargetPct = Math.min(100, charge.targetBatteryPct);
    }
    for (const entry of [...plan.plan.assignments].sort(
      (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt),
    )) {
      const state = ground.get(entry.robotId);
      if (state === undefined) {
        continue;
      }
      const taskState = taskStates.get(entry.taskId);
      if (taskState === undefined || taskState.completedAtMs !== null) {
        continue;
      }
      // Ground-truth single-claim guard: a task already owned by another
      // robot cannot be committed to this one. Without it, every replan
      // re-dispatches still-pending tasks to fresh robots.
      if (taskState.assignedRobotId !== null && taskState.assignedRobotId !== entry.robotId) {
        continue;
      }
      const startMs2 = Date.parse(entry.startAt);
      // Claim up to an hour ahead of the planned departure (claim-early,
      // depart-on-time): a stable lookahead assignment binds to its robot so
      // later replans cannot reshuffle the robot away and starve the task.
      if (startMs2 > comingUntilMs + tickMs + COMMIT_AHEAD_MS) {
        continue;
      }
      if (state.mode === "faulted") {
        continue; // The claim waits for fault clearance.
      }
      // A busy robot may hold a future claim only for work that starts after
      // its current job; overlapping claims would double-book it.
      const busyUntilMs = state.workEndMs ?? nowMs;
      if (state.mode === "traveling" || state.mode === "executing") {
        if (startMs2 < busyUntilMs) {
          continue;
        }
      } else if (state.pendingDispatchAtMs !== null) {
        continue; // Already claimed — the dispatch tick handles it.
      }
      if (state.commsBlockedUntilMs !== null && nowMs < state.commsBlockedUntilMs) {
        continue; // Command channel is down — the dispatch cannot reach the robot.
      }
      const site = scenario.sites.get(taskState.task.siteId);
      if (site === undefined) {
        throw new SchedulerError(
          "CONTEXT_INVALID",
          `task "${taskState.task.taskId}" references unknown site "${taskState.task.siteId}"`,
        );
      }
      taskState.assignedRobotId = entry.robotId;
      state.pendingTaskId = entry.taskId;
      state.pendingDispatchAtMs = startMs2;
      state.chargeTargetPct = state.mode === "charging" ? state.chargeTargetPct : null;
      world.assignTask(state.robot.robotId, entry.taskId);
      world.assignSite(state.robot.robotId, taskState.task.siteId);
    }
  };

  const tickExecution = (tickStartMs: number, tickEndMs: number): void => {
    const hours = (tickEndMs - tickStartMs) / 3_600_000;
    for (const state of ground.values()) {
      // Claimed dispatches fire at the claimed time: departures, attempt
      // counting, and the comms check happen here — not at claim time. A
      // busy robot's claim survives until it frees up; only then it departs.
      if (state.pendingDispatchAtMs !== null && tickEndMs >= state.pendingDispatchAtMs) {
        if (state.mode === "faulted") {
          continue; // The claim holds until the fault clears.
        }
        if (state.mode === "charging") {
          closeCharging(state.robot.robotId, tickStartMs);
          state.chargeTargetPct = null;
          state.mode = "idle";
        }
        if (state.mode === "idle") {
          const dispatched =
            state.pendingTaskId === null ? undefined : taskStates.get(state.pendingTaskId);
          const site =
            dispatched === undefined ? undefined : scenario.sites.get(dispatched.task.siteId);
          if (
            dispatched !== undefined &&
            site !== undefined &&
            !(state.commsBlockedUntilMs !== null && tickStartMs < state.commsBlockedUntilMs)
          ) {
            dispatched.attempts += 1;
            state.mode = "traveling";
            state.currentTaskId = state.pendingTaskId;
            const travelMinutes = (distanceKm(state.pose, site) / resolved.travelSpeedKmh) * 60;
            state.arriveAtMs = Math.max(
              state.pendingDispatchAtMs,
              tickStartMs + travelMinutes * 60_000,
            );
            state.workEndMs = state.arriveAtMs + dispatched.task.estMinutes * 60_000;
            state.pendingDispatchAtMs = null;
            state.pendingTaskId = null;
          }
          continue;
        }
        continue; // Traveling/executing: the claim persists until the robot is idle.
      }
      if (state.mode === "charging") {
        const from = state.siteId;
        state.batteryPct = Math.min(
          state.chargeTargetPct ?? 100,
          state.batteryPct + chargePctPerHour(state.robot) * hours,
        );
        accumulateEnergy(
          from,
          state.robot.kind,
          chargePowerKw(state.robot),
          tickStartMs,
          tickEndMs,
        );
        const open = openCharging.get(state.robot.robotId);
        if (open === undefined) {
          openCharging.set(state.robot.robotId, {
            startMs: tickStartMs,
            kwh: chargePowerKw(state.robot) * hours,
          });
        } else {
          open.kwh += chargePowerKw(state.robot) * hours;
        }
        if (state.batteryPct >= (state.chargeTargetPct ?? 100) - 1e-9) {
          closeCharging(state.robot.robotId, tickEndMs);
          state.mode = "idle";
          state.chargeTargetPct = null;
        }
        continue;
      }
      closeCharging(state.robot.robotId, tickStartMs);
      if (state.mode === "faulted") {
        continue; // clearExpiredFault handled resume at tick start.
      }
      if (state.mode === "traveling") {
        const taskState =
          state.currentTaskId === null ? undefined : taskStates.get(state.currentTaskId);
        if (taskState === undefined) {
          state.mode = "idle";
          continue;
        }
        const site = scenario.sites.get(taskState.task.siteId);
        if (site === undefined) {
          state.mode = "idle";
          continue;
        }
        const travelDrain = drainPctPerHour(state.robot) * resolved.travelDrainFactor * hours;
        state.batteryPct -= travelDrain;
        accumulateEnergy(
          state.siteId,
          state.robot.kind,
          workPowerKw(state.robot) * resolved.travelDrainFactor,
          tickStartMs,
          tickEndMs,
        );
        if (state.batteryPct <= 0) {
          killTaskBatteryDeath(state, tickStartMs);
          continue;
        }
        if (state.arriveAtMs !== null && tickEndMs >= state.arriveAtMs) {
          state.mode = "executing";
          state.pose = site;
          state.siteId = taskState.task.siteId;
        }
        continue;
      }
      if (state.mode === "executing") {
        const taskState =
          state.currentTaskId === null ? undefined : taskStates.get(state.currentTaskId);
        if (taskState === undefined) {
          state.mode = "idle";
          continue;
        }
        state.batteryPct -= drainPctPerHour(state.robot) * hours;
        accumulateEnergy(
          state.siteId,
          state.robot.kind,
          workPowerKw(state.robot),
          tickStartMs,
          tickEndMs,
        );
        measureViolations(state, tickStartMs, tickEndMs);
        openWorkFor(
          state.robot.robotId,
          taskState.task.taskId,
          tickStartMs,
          workPowerKw(state.robot) * hours,
        );
        if (state.batteryPct <= 0) {
          closeWork(state.robot.robotId, tickEndMs);
          killTaskBatteryDeath(state, tickStartMs);
          continue;
        }
        if (state.workEndMs !== null && tickEndMs >= state.workEndMs) {
          const completedAt = Math.max(state.workEndMs, tickStartMs);
          taskState.completedAtMs = completedAt;
          taskState.onTime = completedAt <= Date.parse(taskState.task.window.notAfter);
          taskState.assignedRobotId = null;
          closeWork(state.robot.robotId, Math.max(state.workEndMs, tickStartMs));
          state.mode = "idle";
          state.currentTaskId = null;
          state.pendingDispatchAtMs = null;
          state.pendingTaskId = null;
          state.arriveAtMs = null;
          state.workEndMs = null;
          world.assignTask(state.robot.robotId, null);
        }
      }
    }
  };

  /** Measured hard-constraint violations during real work — both schedulers must score 0. */
  const measureViolations = (
    state: GroundTruthRobot,
    tickStartMs: number,
    tickEndMs: number,
  ): void => {
    for (const pack of scenario.packs) {
      if (!packAppliesTo(pack, { siteId: state.siteId, robotKind: state.robot.kind })) {
        continue;
      }
      for (const constraint of pack.hard) {
        if (constraint.rule === "time-window") {
          if (
            intervalForbidden(
              tickStartMs,
              tickEndMs,
              constraint.forbiddenWindows,
              scenario.localOffsetMinutes,
            )
          ) {
            metrics.hardWindowViolations += 1;
          }
        } else {
          const condition = conditionAt(scenario.weather, tickStartMs);
          if (condition !== null && constraint.forbiddenConditions.includes(condition)) {
            metrics.hardWindowViolations += 1;
          }
        }
      }
    }
  };

  const wasExecutingBeforeFault = new Map<string, boolean>();
  const openWorkFor = (
    robotId: string,
    taskId: string,
    tickStartMs: number,
    kwh: number,
  ): { taskId: string; startMs: number; kwh: number } => {
    const open = openWork.get(robotId);
    if (open !== undefined && open.taskId === taskId) {
      open.kwh += kwh;
      return open;
    }
    if (open !== undefined) {
      closeWork(robotId, tickStartMs);
    }
    const fresh = { taskId, startMs: tickStartMs, kwh };
    openWork.set(robotId, fresh);
    return fresh;
  };
  let tickStartMs = startMs;
  while (tickStartMs < endMs) {
    const tickEndMs = Math.min(tickStartMs + tickMs, endMs);

    // 1. Inject faults scheduled inside this tick (id-stable, once).
    for (const injection of scenario.faultInjections) {
      const atMs = Date.parse(injection.ts);
      if (atMs >= tickStartMs && atMs < tickEndMs) {
        const state = ground.get(injection.robotId);
        if (state !== undefined) {
          wasExecutingBeforeFault.set(
            injection.robotId,
            state.mode === "executing" || state.mode === "traveling",
          );
          raiseFault(state, injection, atMs);
        }
      }
    }

    // 1b. Apply connectivity windows (telemetry blackout without a fault).
    for (const [robotId] of connectivityByRobot) {
      const state = ground.get(robotId);
      if (state !== undefined && telemetryBlockedAt(robotId, tickStartMs)) {
        state.commsBlockedUntilMs = tickStartMs + tickMs;
      }
    }

    // 2. Clear expired faults (resuming interrupted work where the fault
    //    allows it — BATTERY deaths never resume this way).
    for (const [robotId, state] of ground) {
      if (state.faultUntilMs !== null && tickEndMs >= state.faultUntilMs) {
        const resume =
          wasExecutingBeforeFault.get(robotId) === true && state.currentTaskId !== null;
        if (state.mode === "faulted") {
          state.mode = resume ? "executing" : "idle";
        }
        state.faultUntilMs = null;
        state.activeFault = null;
        if (state.commsBlockedUntilMs !== null && tickEndMs >= state.commsBlockedUntilMs) {
          state.commsBlockedUntilMs = null;
        }
      }
    }

    // 3. Physics and task execution for this tick.
    tickExecution(tickStartMs, tickEndMs);

    // 4. Telemetry emission (post-physics: the shadow sees the tick's result).
    for (const state of ground.values()) {
      emitTelemetry(state, iso(tickEndMs));
    }

    // 5. Replan on cadence — the scheduler sees ONLY the world model.
    const replanDue = ((tickEndMs - startMs) / 60_000) % resolved.replanIntervalMinutes === 0;
    if (replanDue) {
      const estimate = world.snapshot();
      const pending: SchedulableTask[] = [];
      // 6-hour lookahead: future-window tasks are offered so the planner can
      // pre-charge off-peak for them; the schedulers still gate starts at
      // notBefore.
      const lookaheadMs = tickEndMs + 6 * 3_600_000;
      for (const taskState of taskStates.values()) {
        if (
          taskState.completedAtMs === null &&
          taskState.assignedRobotId === null &&
          // Retry cap: a task abandoned twice (e.g. two battery deaths) is not
          // offered again — it stays incomplete without a dispatch loop.
          taskState.attempts < 2 &&
          Date.parse(taskState.task.window.notBefore) <= lookaheadMs
        ) {
          pending.push(taskState.task);
        }
      }
      const context: SchedulingContext = {
        estimate,
        sites: scenario.sites,
        localOffsetMinutes: scenario.localOffsetMinutes,
        ...(scenario.weather === undefined ? {} : { weather: scenario.weather }),
        travelSpeedKmh: resolved.travelSpeedKmh,
        travelDrainFactor: resolved.travelDrainFactor,
        slotStepMinutes: resolved.slotStepMinutes,
        maxStartSlots: resolved.maxStartSlots,
      };
      const plan = scheduler(scenario.fleet, pending, context, scenario.objective, scenario.packs);
      metrics.plansGenerated += 1;
      metrics.unassignedTaskEvents += plan.unassigned.length;
      commitPlan(plan, tickEndMs + resolved.replanIntervalMinutes * 60_000);
    }

    nowMs = tickEndMs;
    tickStartMs = tickEndMs;
  }

  // Flush any intervals still open at horizon end.
  for (const robotId of [...openCharging.keys()]) {
    closeCharging(robotId, endMs);
  }
  for (const robotId of [...openWork.keys()]) {
    closeWork(robotId, endMs);
  }

  const completed = [...taskStates.values()].filter((t) => t.completedAtMs !== null);
  const onTime = completed.filter((t) => t.onTime);
  const tasksTotal = taskStates.size;
  const robotHours = (scenario.fleet.length * scenario.horizonMinutes) / 60;
  return {
    schedulerTag:
      scheduler === planSchedule
        ? "risk-aware"
        : scheduler === ruleBasedBaseline
          ? "baseline"
          : "custom",
    scenarioId: scenario.scenarioId,
    seed: scenario.seed,
    tasksTotal,
    tasksCompleted: completed.length,
    tasksOnTime: onTime.length,
    onTimeCompletion: tasksTotal === 0 ? 1 : onTime.length / tasksTotal,
    interventions: metrics.interventions,
    robotHours,
    interventionsPer100RobotHours:
      robotHours === 0 ? 0 : (metrics.interventions / robotHours) * 100,
    energyKwh: Math.round(metrics.energyKwh * 1000) / 1000,
    energyCostUsd: Math.round(metrics.energyCostUsd * 1000) / 1000,
    hardWindowViolations: metrics.hardWindowViolations,
    plansGenerated: metrics.plansGenerated,
    unassignedTaskEvents: metrics.unassignedTaskEvents,
    batteryDeaths: metrics.batteryDeaths,
    chargingIntervals,
    workIntervals,
    taskOutcomes: [...taskStates.values()].map((t) => ({
      taskId: t.task.taskId,
      status: t.completedAtMs === null ? "incomplete" : "completed",
      attempts: t.attempts,
      completedAt: t.completedAtMs === null ? null : iso(t.completedAtMs),
      onTime: t.onTime,
    })),
  };
}
