import type { FleetTask, GeoPoint, Robot, WeatherCondition } from "@fleetos/core-schema";
import type { FleetStateEstimate } from "@fleetos/world-model";

import { SchedulerError } from "./errors.js";

/**
 * The task shape the scheduling core plans against: the core-schema
 * `FleetTask` plus the operator's nominal duration estimate. The landed
 * `FleetTask` schema carries no duration (the plan produces `estMinutes`),
 * so the scheduling contract adds it at the package boundary — the one
 * deliberate delta from the design doc's `FleetTask[]` sketch.
 */
export interface SchedulableTask extends FleetTask {
  /** Operator-estimated work duration in minutes (nominal, before risk inflation). */
  readonly estMinutes: number;
}

/**
 * Forecast weather as a step function: the condition in force from `from`
 * (inclusive) until the next entry. Optional in `SchedulingContext` — when
 * absent, weather-cutoff constraints degrade to runtime holds (the robot/site
 * enforces them, WEATHER_HOLD semantics) instead of planner feasibility gates.
 */
export interface ForecastCondition {
  /** RFC 3339 instant from which this condition is in force. */
  readonly from: string;
  readonly condition: WeatherCondition;
}

/**
 * The scheduler's situational input. `estimate` is the world-model snapshot
 * (design doc: `telemetry: TelemetrySummary — world-model snapshot in
 * practice`); the remaining fields are fleet-static geography and scenario
 * time policy the world-model snapshot does not carry.
 */
export interface SchedulingContext {
  /** Digital-shadow snapshot at the decision instant (slices sorted by robotId). */
  readonly estimate: FleetStateEstimate;
  /** Coordinates per siteId — travel cost and distance need geography. */
  readonly sites: ReadonlyMap<string, GeoPoint>;
  /**
   * Scenario/site timezone offset in minutes (e.g. -480 for UTC-8) — daily
   * windows in constraint packs are local wall-clock times.
   */
  readonly localOffsetMinutes: number;
  /** Step-function forecast; omit when no forecast is available. */
  readonly weather?: readonly ForecastCondition[];
  /** Fleet-average reposition speed for travel-time estimation (km/h). */
  readonly travelSpeedKmh?: number;
  /** Travel energy as a fraction of the nominal work draw (mowers draw less in transit). */
  readonly travelDrainFactor?: number;
  /** Start-slot enumeration granularity in minutes. */
  readonly slotStepMinutes?: number;
  /** Hard cap on start slots scanned per (task, robot) pair. */
  readonly maxStartSlots?: number;
}

/** A SchedulingContext with every optional policy field resolved. */
export interface ResolvedContext extends SchedulingContext {
  readonly travelSpeedKmh: number;
  readonly travelDrainFactor: number;
  readonly slotStepMinutes: number;
  readonly maxStartSlots: number;
}

export const DEFAULT_TRAVEL_SPEED_KMH = 20;
export const DEFAULT_TRAVEL_DRAIN_FACTOR = 0.5;
export const DEFAULT_SLOT_STEP_MINUTES = 15;
export const DEFAULT_MAX_START_SLOTS = 32;

/** Fills optional context policy with documented defaults and refuses nonsense. */
export function resolveContext(context: SchedulingContext): ResolvedContext {
  const resolved: ResolvedContext = {
    estimate: context.estimate,
    sites: context.sites,
    localOffsetMinutes: context.localOffsetMinutes,
    ...(context.weather === undefined ? {} : { weather: context.weather }),
    travelSpeedKmh: context.travelSpeedKmh ?? DEFAULT_TRAVEL_SPEED_KMH,
    travelDrainFactor: context.travelDrainFactor ?? DEFAULT_TRAVEL_DRAIN_FACTOR,
    slotStepMinutes: context.slotStepMinutes ?? DEFAULT_SLOT_STEP_MINUTES,
    maxStartSlots: context.maxStartSlots ?? DEFAULT_MAX_START_SLOTS,
  };
  if (!Number.isFinite(resolved.travelSpeedKmh) || resolved.travelSpeedKmh <= 0) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `travelSpeedKmh must be positive, got ${String(resolved.travelSpeedKmh)}`,
    );
  }
  if (
    !Number.isFinite(resolved.travelDrainFactor) ||
    resolved.travelDrainFactor < 0 ||
    resolved.travelDrainFactor > 1
  ) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `travelDrainFactor must be in [0, 1], got ${String(resolved.travelDrainFactor)}`,
    );
  }
  if (!Number.isInteger(resolved.slotStepMinutes) || resolved.slotStepMinutes <= 0) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `slotStepMinutes must be a positive integer, got ${String(resolved.slotStepMinutes)}`,
    );
  }
  if (!Number.isInteger(resolved.maxStartSlots) || resolved.maxStartSlots < 1) {
    throw new SchedulerError(
      "CONTEXT_INVALID",
      `maxStartSlots must be a positive integer, got ${String(resolved.maxStartSlots)}`,
    );
  }
  return resolved;
}

/** Condition in force at an instant; null when no forecast covers it. */
export function conditionAt(
  forecast: readonly ForecastCondition[] | undefined,
  instantMs: number,
): WeatherCondition | null {
  if (forecast === undefined) {
    return null;
  }
  let current: ForecastCondition | null = null;
  for (const entry of forecast) {
    if (Date.parse(entry.from) <= instantMs) {
      current = entry;
    } else {
      break;
    }
  }
  return current?.condition ?? null;
}

/** Haversine distance in kilometers. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

/** The fleet records the scheduler reads, sorted by robotId for determinism. */
export function sortedFleet(fleet: readonly Robot[]): readonly Robot[] {
  return [...fleet].sort((a, b) => (a.robotId < b.robotId ? -1 : a.robotId > b.robotId ? 1 : 0));
}
