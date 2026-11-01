import type {
  ExternalConstraintPack,
  FaultEvent,
  GeoPoint,
  Robot,
  RobotKind,
  TelemetrySample,
} from "@fleetos/core-schema";

/**
 * Coarse operational state of one robot in the digital shadow. Derived, never
 * reported by vendors — the same normalized telemetry/fault stream produces
 * the same state for every OEM.
 *
 * Derivation precedence (why this order):
 * 1. `unseen` — registered, no telemetry ever received: no estimate without data.
 * 2. `unreachable` — an active COMMS_LOST fault (explicit link-loss evidence)
 *    or data age past the unreachable threshold (absence of data is weaker
 *    evidence but, past the threshold, decisive).
 * 3. `stale` — data age past the fresh window: the estimate is only as good
 *    as its data age, so staleness outranks the fault overlay below (the
 *    fault itself stays visible on the slice's `activeFault` field).
 * 4. `degraded` — active SENSOR_DEGRADED fault: working, data quality down.
 * 5. `faulted` — any other active fault (BATTERY, STUCK, WEATHER_HOLD,
 *    MAINTENANCE_DUE).
 * 6. Telemetry motion state: `charging` > `executing` > `idle`.
 */
export const SHADOW_SLICE_STATES = [
  "unseen",
  "idle",
  "executing",
  "charging",
  "faulted",
  "degraded",
  "stale",
  "unreachable",
] as const;
export type ShadowSliceState = (typeof SHADOW_SLICE_STATES)[number];

/**
 * One robot's slice of the digital shadow — the device-agent input (spec:
 * every device's agent is derived from its digital-twin slice) and the
 * scheduler-facing fleet-state unit. All values are derived from the
 * normalized event stream; nothing here is vendor-specific.
 */
export interface DigitalShadowSlice {
  readonly robotId: string;
  readonly vendor: string;
  readonly kind: RobotKind;
  readonly state: ShadowSliceState;
  /** World-model confidence in [0, 1] — the scheduler's down-weighting input. */
  readonly confidence: number;
  readonly batteryPct: number | null;
  readonly charging: boolean | null;
  readonly pose: GeoPoint | null;
  readonly progressPct: number | null;
  /** Open task assignment (assigned via assignTask, e.g. from a committed plan). */
  readonly currentTaskId: string | null;
  readonly lastTelemetryAt: string | null;
  /** Seconds since the last telemetry sample at snapshot time; null when never seen. */
  readonly dataAgeSeconds: number | null;
  readonly activeFault: FaultEvent | null;
  /** Most recent fault of any kind, even after it cleared — triage context. */
  readonly lastFault: FaultEvent | null;
  /** Constraint packs in force for this robot at snapshot time (spec: active constraint packs on the slice). */
  readonly activeConstraintPacks: readonly ExternalConstraintPack[];
}

/** Fleet-wide estimate at one instant: every registered robot's slice, sorted by robotId. */
export interface FleetStateEstimate {
  readonly at: string;
  readonly robots: readonly DigitalShadowSlice[];
}

/** Thresholds shared by state derivation and confidence staleness. */
export interface StalenessThresholds {
  readonly staleAfterSeconds: number;
  readonly unreachableAfterSeconds: number;
}

/** The inputs state derivation reads — a structural view of one robot's shadow memory. */
export interface SliceDerivationInput {
  readonly lastSample: TelemetrySample | null;
  readonly activeFault: FaultEvent | null;
  readonly currentTaskId: string | null;
  /** Seconds since the last telemetry sample; null when never seen. */
  readonly dataAgeSeconds: number | null;
}

/**
 * Pure slice-state derivation (see the precedence doc on SHADOW_SLICE_STATES).
 * Exported for direct unit testing and for consumers that need to re-derive a
 * state from a slice's own fields.
 */
export function deriveSliceState(
  input: SliceDerivationInput,
  thresholds: StalenessThresholds,
): ShadowSliceState {
  const { lastSample, activeFault, currentTaskId, dataAgeSeconds } = input;
  if (lastSample === null || dataAgeSeconds === null) {
    return "unseen";
  }
  const commsLost = activeFault?.type === "COMMS_LOST";
  if (commsLost || dataAgeSeconds > thresholds.unreachableAfterSeconds) {
    return "unreachable";
  }
  if (dataAgeSeconds > thresholds.staleAfterSeconds) {
    return "stale";
  }
  if (activeFault?.type === "SENSOR_DEGRADED") {
    return "degraded";
  }
  if (activeFault !== null) {
    return "faulted";
  }
  if (lastSample.charging) {
    return "charging";
  }
  if (lastSample.progressPct !== undefined || currentTaskId !== null) {
    return "executing";
  }
  return "idle";
}

/** The slice fields the world model copies straight from the registry record. */
export function sliceIdentity(
  robot: Robot,
): Pick<DigitalShadowSlice, "robotId" | "vendor" | "kind"> {
  return { robotId: robot.robotId, vendor: robot.vendor, kind: robot.kind };
}
