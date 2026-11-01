import type { FaultEvent, TelemetrySample } from "@fleetos/core-schema";

/**
 * Degraded-mode logic (spec fleet-health chapter, design doc §10): a
 * COMMS_LOST fault marks the robot DEGRADED, and while the link is down its
 * telemetry is excluded from optimization — stale data must not improve a
 * plan (testing plan §5.2). A telemetry sample timestamped strictly after
 * the comms-loss fault proves the link back and restores the robot; the
 * restoring sample itself is still not admitted (it was not trusted data),
 * so optimization only ever sees post-restoration samples.
 *
 * This mirrors the world model's clearing rule (shadow.ts: COMMS_LOST clears
 * on any fresh sample) at the fleet-health boundary — the world model derives
 * shadow state; this tracker decides what the scheduler is fed.
 */

/** Coarse fleet-health state of one robot: never seen, working, or DEGRADED. */
export type HealthState = "unknown" | "healthy" | "degraded";

interface RobotLinkState {
  /** The COMMS_LOST fault that degraded the robot, when active. */
  fault: FaultEvent | null;
}

export interface DegradedModeTracker {
  /** Marks the robot DEGRADED on a comms-loss fault (idempotent per fault). */
  markDegraded(robotId: string, fault: FaultEvent): void;
  /**
   * Records a telemetry sample for link-state bookkeeping. Returns true when
   * the sample restored a degraded link (fresh evidence after COMMS_LOST).
   */
  recordTelemetry(sample: TelemetrySample): boolean;
  isDegraded(robotId: string): boolean;
  healthOf(robotId: string): HealthState;
  degradedRobots(): ReadonlySet<string>;
  /** Optimization-feed gate: false while the robot is DEGRADED. */
  admitTelemetry(sample: TelemetrySample): boolean;
}

export function createDegradedModeTracker(): DegradedModeTracker {
  const links = new Map<string, RobotLinkState>();

  const linkState = (robotId: string): RobotLinkState => {
    let state = links.get(robotId);
    if (!state) {
      state = { fault: null };
      links.set(robotId, state);
    }
    return state;
  };

  return {
    markDegraded(robotId: string, fault: FaultEvent): void {
      if (fault.type !== "COMMS_LOST") {
        return; // only comms loss degrades the link; other faults are handled elsewhere
      }
      const state = linkState(robotId);
      if (state.fault === null || Date.parse(fault.ts) > Date.parse(state.fault.ts)) {
        state.fault = fault;
      }
    },
    recordTelemetry(sample: TelemetrySample): boolean {
      const state = linkState(sample.robotId);
      if (state.fault === null) {
        return false;
      }
      if (Date.parse(sample.ts) > Date.parse(state.fault.ts)) {
        state.fault = null; // a fresh sample is itself proof the link is back
        return true;
      }
      return false;
    },
    isDegraded: (robotId: string) => linkState(robotId).fault !== null,
    healthOf: (robotId: string) => {
      const state = links.get(robotId);
      if (!state) return "unknown";
      return state.fault === null ? "healthy" : "degraded";
    },
    degradedRobots: () => {
      const degraded = new Set<string>();
      for (const [robotId, state] of links) {
        if (state.fault !== null) degraded.add(robotId);
      }
      return degraded;
    },
    admitTelemetry: (sample: TelemetrySample) => linkState(sample.robotId).fault === null,
  };
}
