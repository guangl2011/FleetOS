import type {
  FaultEvent,
  FaultSeverity,
  FaultType,
  GeoPoint,
  Robot,
  TelemetrySample,
} from "@fleetos/core-schema";
import { exampleRobotMower, exampleRobotScrubber } from "@fleetos/core-schema";
import { ManualClock } from "@fleetos/adapters-sdk";

/** Canonical fixture robots, deep-cloned per call so tests cannot cross-contaminate. */
export function mowerRobot(robotId = "robot-mower-01"): Robot {
  const robot = structuredClone(exampleRobotMower);
  robot.robotId = robotId;
  return robot;
}

export function scrubberRobot(robotId = "robot-scrubber-01"): Robot {
  const robot = structuredClone(exampleRobotScrubber);
  robot.robotId = robotId;
  return robot;
}

const POSE: GeoPoint = { lat: 47.6062, lon: -122.3321 };

/** Builds a telemetry sample stamped at `ts` — progress omitted unless given. */
export function sampleAt(
  ts: string,
  robotId: string,
  overrides: Partial<
    Pick<TelemetrySample, "batteryPct" | "charging" | "pose" | "progressPct">
  > = {},
): TelemetrySample {
  return {
    robotId,
    ts,
    batteryPct: 80,
    charging: false,
    pose: POSE,
    ...overrides,
  };
}

/** Builds a normalized fault event stamped at `ts`. */
export function faultAt(
  faultId: string,
  robotId: string,
  ts: string,
  type: FaultType,
  severity: FaultSeverity,
  overrides: Partial<Pick<FaultEvent, "taskId" | "detail">> = {},
): FaultEvent {
  return {
    faultId,
    robotId,
    ts,
    type,
    severity,
    message: `${type} fault (${faultId})`,
    ...overrides,
  };
}

/** ISO timestamp `seconds` after the epoch instant 2026-11-02T08:00:00Z. */
export function at(seconds: number): string {
  return new Date(Date.parse("2026-11-02T08:00:00Z") + seconds * 1000).toISOString();
}

export { ManualClock };
