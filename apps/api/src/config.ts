import { RegionSchema } from "@fleetos/core-schema";
import type { RobotAdapter } from "@fleetos/adapters-sdk";
import type { WorldClock } from "@fleetos/world-model";
import type { PartialSchedulingObjective } from "@fleetos/scheduler";

import { ApiError } from "./errors.js";

/**
 * API configuration — deployment choices, not runtime state. Residency is
 * configured here (spec data-compliance chapter): the regions the operator
 * will store telemetry in. Telemetry routes to the per-robot region declared
 * in the robot's compliance block; an ingest whose region is not permitted
 * is rejected, never persisted.
 */
export interface ResidencyConfig {
  /** Region slugs the deployment stores telemetry in (lowercase slugs). */
  readonly allowedRegions: readonly string[];
}

export interface SiteInput {
  readonly siteId: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export interface ApiOptions {
  /** Directory for the SQLite main store and the per-region telemetry files. */
  readonly dataDir: string;
  readonly residency: ResidencyConfig;
  /** Adapters to bind; defaults to the four OEM simulators. */
  readonly adapters?: readonly RobotAdapter[];
  /** Site geography the scheduler plans against (bootstrap config, read-only via the API). */
  readonly sites?: readonly SiteInput[];
  /** Shared injected clock — engine, world model, agents, and store stamps. */
  readonly clock?: WorldClock;
  /** Site timezone offset in minutes for local-clock constraint windows. */
  readonly localOffsetMinutes?: number;
  /** Objective the scheduler plans with (POST /schedule/plan may override per plan). */
  readonly objective?: PartialSchedulingObjective;
}

/** The partial config callers may pass; required pieces are validated, not silently defaulted. */
export type ApiOptionsInput = Partial<Omit<ApiOptions, "residency">> & {
  residency?: Partial<ResidencyConfig>;
};

/** Validates and normalizes the deployment config; refuses nonsense at boot. */
export function resolveApiOptions(input: ApiOptionsInput): ApiOptions {
  const allowedRegions = input.residency?.allowedRegions ?? [];
  if (allowedRegions.length === 0) {
    throw new ApiError(500, "CONFIG_INVALID", "residency.allowedRegions must not be empty");
  }
  for (const region of allowedRegions) {
    const parsed = RegionSchema.safeParse(region);
    if (!parsed.success) {
      throw new ApiError(500, "CONFIG_INVALID", `residency region "${region}" is not a valid region slug`);
    }
  }
  if (input.dataDir === undefined || input.dataDir.length === 0) {
    throw new ApiError(500, "CONFIG_INVALID", "dataDir is required — pass the deployment's SQLite directory");
  }
  return { ...input, dataDir: input.dataDir, residency: { allowedRegions } };
}

/** Parses a comma-separated region list (FLEETOS_REGIONS env format). */
export function parseRegions(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((region) => region.trim())
    .filter((region) => region.length > 0);
}
