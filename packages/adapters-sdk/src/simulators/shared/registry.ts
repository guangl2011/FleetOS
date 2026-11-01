import type { Robot } from "@fleetos/core-schema";

/**
 * Registry helper shared by the simulators: while an adapter is degraded, its
 * reported data quality halves — the same convention as the reference
 * in-memory adapter, so the world model re-weights degraded robots uniformly
 * across vendors.
 */
export const DEGRADED_CONFIDENCE_FACTOR = 0.5;

export function withDegradedConfidence(robots: readonly Robot[]): Robot[] {
  return structuredClone(robots).map((robot) => ({
    ...robot,
    confidence: Math.min(1, Math.max(0, robot.confidence * DEGRADED_CONFIDENCE_FACTOR)),
  }));
}
