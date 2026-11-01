import type {
  ExternalConstraintPack,
  FaultEvent,
  Robot,
  TelemetrySample,
} from "@fleetos/core-schema";
import { EntityIdSchema } from "@fleetos/core-schema";

import { estimateConfidence, mergeTuning } from "./confidence.js";
import type { ConfidenceTuning } from "./confidence.js";
import type { WorldClock } from "./clock.js";
import { systemClock } from "./clock.js";
import { WorldModelError } from "./errors.js";
import { isFaultEvent } from "./events.js";
import type { WorldModelEvent } from "./events.js";
import { packsForRobot } from "./packs.js";
import type { PackSource } from "./packs.js";
import { createDeterministicPredictor } from "./predictor.js";
import type { FleetPredictor, PredictedFutures } from "./predictor.js";
import { deriveSliceState } from "./state.js";
import type { DigitalShadowSlice, FleetStateEstimate, ShadowSliceState } from "./state.js";
import { sliceIdentity } from "./state.js";

/** The digital shadow over the normalized fleet — spec D1's world-model surface. */
export interface FleetWorldModel {
  /** Id of the predictor currently behind the seam (e.g. "deterministic-v1"). */
  readonly predictorId: string;
  /** Absorbs one normalized telemetry sample or fault event. */
  ingest(event: WorldModelEvent): void;
  ingestAll(events: readonly WorldModelEvent[]): void;
  /** The fleet-state estimate at the clock's current instant, slices sorted by robotId. */
  snapshot(): FleetStateEstimate;
  /**
   * One robot's slice for a device agent; null for an unregistered id —
   * typed absence (device agents may legitimately probe), not an error.
   */
  sliceFor(robotId: string): DigitalShadowSlice | null;
  /** Per-robot confidence in [0, 1]. Throws for an unregistered id — a number return type cannot signal absence. */
  confidence(robotId: string): number;
  /** Constraint packs in force for one robot at the current instant. */
  activePacks(robotId: string): readonly ExternalConstraintPack[];
  /** Site attribution for constraint-pack scoping (the scheduler/console set it from committed plans). */
  assignSite(robotId: string, siteId: string | null): void;
  /** Open-task attribution (set when a plan commits, cleared on completion/cancel). */
  assignTask(robotId: string, taskId: string | null): void;
  /** Runs the configured predictor over the current estimate — the typed prediction seam. */
  predict(horizonMinutes: number): PredictedFutures;
}

export interface WorldModelOptions {
  /** Registry records — the same normalized capability records the scheduler reads. */
  readonly robots: readonly Robot[];
  /** Defaults to the system clock; simulators and tests inject a manual clock. */
  readonly clock?: WorldClock;
  /** Packs in force at an instant — wire a constraints PackLibrary's packsAt. */
  readonly constraintPacks?: PackSource;
  /** Defaults to the deterministic closed-form projection; Phase I swaps it. */
  readonly predictor?: FleetPredictor;
  /** Overrides for the confidence/staleness defaults; validated at construction. */
  readonly tuning?: Partial<ConfidenceTuning>;
}

/**
 * One robot's shadow memory: everything ingest has observed, everything
 * derived state reads from. Arrival order is the truth (adapter streams are
 * in-order); event timestamps — not arrival — decide clearing.
 */
interface RobotMemory {
  readonly robot: Robot;
  lastSample: TelemetrySample | null;
  activeFault: FaultEvent | null;
  lastFault: FaultEvent | null;
  /** Task progress at the moment the active fault was ingested — the recovery-evidence baseline. */
  progressAtFault: number;
  currentTaskId: string | null;
  siteId: string | null;
}

function robotMemory(
  memory: RobotMemory,
  nowMs: number,
  tuning: ConfidenceTuning,
): {
  state: ShadowSliceState;
  confidence: number;
  dataAgeSeconds: number | null;
} {
  const dataAgeSeconds =
    memory.lastSample === null
      ? null
      : // A future-dated sample means the caller's clock lags its own data;
        // reading it as fully fresh is the safe interpretation, so clamp at 0.
        Math.max(0, (nowMs - Date.parse(memory.lastSample.ts)) / 1000);
  return {
    dataAgeSeconds,
    state: deriveSliceState(
      {
        lastSample: memory.lastSample,
        activeFault: memory.activeFault,
        currentTaskId: memory.currentTaskId,
        dataAgeSeconds,
      },
      tuning,
    ),
    confidence: estimateConfidence(
      memory.robot.confidence,
      dataAgeSeconds,
      memory.activeFault,
      tuning,
    ),
  };
}

/**
 * Clears an active fault on recovery evidence carried by a newer telemetry
 * sample (ts strictly after the fault):
 * - COMMS_LOST clears on any fresh sample — the sample itself proves the link.
 * - Every other fault clears when the robot demonstrably works again:
 *   progress advanced past where it stood when the fault was ingested.
 * Faults otherwise persist until a newer fault supersedes them, so a fault
 * never silently evaporates.
 */
function applyRecoveryEvidence(memory: RobotMemory, sample: TelemetrySample): void {
  const active = memory.activeFault;
  if (active === null || Date.parse(sample.ts) <= Date.parse(active.ts)) {
    return;
  }
  const progressAdvanced =
    sample.progressPct !== undefined && sample.progressPct > memory.progressAtFault;
  if (active.type === "COMMS_LOST" || progressAdvanced) {
    memory.activeFault = null;
  }
}

function parseEntityId(id: string, what: string): string {
  const parsed = EntityIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new WorldModelError("ENTITY_ID_INVALID", `${what} is not a valid entity id: ${id}`);
  }
  return parsed.data;
}

/** Builds the digital shadow over a registered fleet (spec D1 `packages/world-model`). */
export function createWorldModel(options: WorldModelOptions): FleetWorldModel {
  const clock = options.clock ?? systemClock();
  const tuning = mergeTuning(options.tuning);
  const predictor = options.predictor ?? createDeterministicPredictor();

  const registry = new Map<string, RobotMemory>();
  for (const robot of options.robots) {
    if (registry.has(robot.robotId)) {
      throw new WorldModelError(
        "ROBOT_DUPLICATE",
        `duplicate registry record for "${robot.robotId}"`,
      );
    }
    registry.set(robot.robotId, {
      robot,
      lastSample: null,
      activeFault: null,
      lastFault: null,
      progressAtFault: -1,
      currentTaskId: null,
      siteId: null,
    });
  }

  function requireMemory(robotId: string, operation: string): RobotMemory {
    const memory = registry.get(robotId);
    if (memory === undefined) {
      throw new WorldModelError(
        "ROBOT_UNKNOWN",
        `${operation}: robot "${robotId}" is not registered`,
      );
    }
    return memory;
  }

  function ingestTelemetry(sample: TelemetrySample): void {
    const memory = requireMemory(sample.robotId, "telemetry ingest");
    // Monotonicity guard: an out-of-order (older) sample cannot make the
    // shadow younger, so it is ignored as a duplicate — documented, not hidden.
    if (memory.lastSample !== null && Date.parse(sample.ts) < Date.parse(memory.lastSample.ts)) {
      return;
    }
    applyRecoveryEvidence(memory, sample);
    memory.lastSample = sample;
  }

  function ingestFault(fault: FaultEvent): void {
    const memory = requireMemory(fault.robotId, "fault ingest");
    memory.activeFault = fault;
    memory.lastFault = fault;
    memory.progressAtFault = memory.lastSample?.progressPct ?? -1;
  }

  function buildSlice(
    memory: RobotMemory,
    nowMs: number,
    packs: readonly ExternalConstraintPack[],
  ): DigitalShadowSlice {
    const derived = robotMemory(memory, nowMs, tuning);
    return {
      ...sliceIdentity(memory.robot),
      state: derived.state,
      confidence: derived.confidence,
      batteryPct: memory.lastSample?.batteryPct ?? null,
      charging: memory.lastSample?.charging ?? null,
      pose: memory.lastSample?.pose ?? null,
      progressPct: memory.lastSample?.progressPct ?? null,
      currentTaskId: memory.currentTaskId,
      lastTelemetryAt: memory.lastSample?.ts ?? null,
      dataAgeSeconds: derived.dataAgeSeconds,
      activeFault: memory.activeFault,
      lastFault: memory.lastFault,
      activeConstraintPacks: packsForRobot(packs, memory.robot, memory.siteId),
    };
  }

  return {
    predictorId: predictor.id,

    ingest(event: WorldModelEvent): void {
      if (isFaultEvent(event)) {
        ingestFault(event);
      } else {
        ingestTelemetry(event);
      }
    },

    ingestAll(events: readonly WorldModelEvent[]): void {
      for (const event of events) {
        this.ingest(event);
      }
    },

    snapshot(): FleetStateEstimate {
      const now = clock.now();
      const nowMs = Date.parse(now);
      const packs = options.constraintPacks?.(now) ?? [];
      const robotIds = [...registry.keys()].sort();
      return {
        at: now,
        robots: robotIds.map((robotId) => {
          const memory = registry.get(robotId);
          if (memory === undefined) {
            throw new WorldModelError("ROBOT_UNKNOWN", `registry lost robot "${robotId}"`);
          }
          return buildSlice(memory, nowMs, packs);
        }),
      };
    },

    sliceFor(robotId: string): DigitalShadowSlice | null {
      const memory = registry.get(robotId);
      if (memory === undefined) {
        return null;
      }
      const now = clock.now();
      const packs = options.constraintPacks?.(now) ?? [];
      return buildSlice(memory, Date.parse(now), packs);
    },

    confidence(robotId: string): number {
      const memory = requireMemory(robotId, "confidence");
      return robotMemory(memory, Date.parse(clock.now()), tuning).confidence;
    },

    activePacks(robotId: string): readonly ExternalConstraintPack[] {
      const memory = requireMemory(robotId, "activePacks");
      const now = clock.now();
      const packs = options.constraintPacks?.(now) ?? [];
      return packsForRobot(packs, memory.robot, memory.siteId);
    },

    assignSite(robotId: string, siteId: string | null): void {
      const memory = requireMemory(robotId, "assignSite");
      memory.siteId = siteId === null ? null : parseEntityId(siteId, "siteId");
    },

    assignTask(robotId: string, taskId: string | null): void {
      const memory = requireMemory(robotId, "assignTask");
      memory.currentTaskId = taskId === null ? null : parseEntityId(taskId, "taskId");
    },

    predict(horizonMinutes: number): PredictedFutures {
      if (!Number.isFinite(horizonMinutes) || horizonMinutes <= 0) {
        throw new WorldModelError(
          "HORIZON_INVALID",
          `horizonMinutes must be a positive finite number, got ${horizonMinutes}`,
        );
      }
      const robots = new Map<string, Robot>();
      for (const memory of registry.values()) {
        robots.set(memory.robot.robotId, memory.robot);
      }
      return predictor.predict({
        now: clock.now(),
        horizonMinutes,
        fleet: this.snapshot(),
        robots,
      });
    },
  };
}
