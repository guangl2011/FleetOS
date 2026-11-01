import { FAULT_TYPES } from "@fleetos/core-schema";
import type { FaultType } from "@fleetos/core-schema";

import { createSeededRng } from "./seeded-rng.js";

/**
 * Pure, seeded schedule derivation: a scenario seed fully determines which
 * faults fire on which tick, and which robots lose their uplink when. The
 * adapters replay the derived schedule during tick() — runtime consumes no
 * randomness, so a fixed seed replays an identical event trace everywhere.
 */

/** One planned fault: tick index (1-based, matching the adapter's tick counter), robot, normalized class. */
export interface ScheduledFault {
  readonly tickIndex: number;
  readonly robotId: string;
  readonly faultType: FaultType;
}

/** One planned uplink drop window for one robot (1-based tick indices). */
export interface ConnectivityDrop {
  readonly robotId: string;
  readonly startTick: number;
  readonly durationTicks: number;
}

function isFaultType(value: string | undefined): value is FaultType {
  return typeof value === "string" && (FAULT_TYPES as readonly string[]).includes(value);
}

/**
 * Derives `eventCount` faults for `maxTick` ticks of a scenario. Tick indices
 * are strictly increasing with gaps of 1-3 ticks; fault classes are drawn
 * uniformly. Pure in (seed, robotIds, eventCount, maxTick).
 */
export function deriveFaultSchedule(
  seed: number,
  robotIds: readonly string[],
  eventCount: number,
  maxTick: number,
): ScheduledFault[] {
  if (robotIds.length === 0) {
    throw new RangeError("deriveFaultSchedule requires at least one robot");
  }
  const rng = createSeededRng(seed);
  const events: ScheduledFault[] = [];
  let cursor = 0;
  for (let i = 0; i < eventCount; i += 1) {
    const tickIndex = Math.min(cursor + 1 + rng.intBelow(3), maxTick);
    cursor = tickIndex;
    const robotId = rng.pick(robotIds);
    const drawn = FAULT_TYPES[rng.intBelow(FAULT_TYPES.length)];
    if (!isFaultType(drawn)) {
      throw new RangeError(`deriveFaultSchedule produced an invalid fault type: ${String(drawn)}`);
    }
    events.push({ tickIndex, robotId, faultType: drawn });
  }
  return events;
}

/**
 * Derives per-robot uplink drop windows for `maxTick` ticks: 1-2 drops per
 * robot, 1-2 ticks each, gaps of 1-3 ticks between drops. Windows for one
 * robot never overlap. Pure in (seed, robotIds, maxTick).
 */
export function deriveConnectivitySchedule(
  seed: number,
  robotIds: readonly string[],
  maxTick: number,
): ConnectivityDrop[] {
  if (robotIds.length === 0) {
    throw new RangeError("deriveConnectivitySchedule requires at least one robot");
  }
  const rng = createSeededRng(seed);
  const drops: ConnectivityDrop[] = [];
  for (const robotId of robotIds) {
    const dropCount = 1 + rng.intBelow(2);
    let cursor = rng.intBelow(2) + 1; // first drop starts at tick 1 or 2
    for (let i = 0; i < dropCount; i += 1) {
      const durationTicks = 1 + rng.intBelow(2);
      const startTick = Math.min(cursor, maxTick);
      drops.push({ robotId, startTick, durationTicks });
      cursor = startTick + durationTicks + 1 + rng.intBelow(3);
      if (cursor > maxTick) break;
    }
  }
  return drops;
}

/** Is `robotId`'s uplink down at `tickIndex`, given a derived schedule? */
export function uplinkDownAt(
  drops: readonly ConnectivityDrop[],
  robotId: string,
  tickIndex: number,
): boolean {
  return drops.some(
    (drop) =>
      drop.robotId === robotId &&
      tickIndex >= drop.startTick &&
      tickIndex < drop.startTick + drop.durationTicks,
  );
}
