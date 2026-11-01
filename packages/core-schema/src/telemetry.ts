import { z } from "zod";

import { EntityIdSchema, IsoDateTimeSchema, PercentSchema } from "./primitives.js";

export const GeoPointSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export type GeoPoint = z.infer<typeof GeoPointSchema>;

/**
 * One normalized telemetry sample. Adapters emit these regardless of vendor
 * schema; the world model absorbs them into the digital shadow (spec D1).
 */
export const TelemetrySampleSchema = z.strictObject({
  robotId: EntityIdSchema,
  ts: IsoDateTimeSchema,
  batteryPct: PercentSchema,
  charging: z.boolean(),
  pose: GeoPointSchema.optional(),
  /** Progress on the active task in [0, 100]; absent when idle. */
  progressPct: PercentSchema.optional(),
});

export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;
