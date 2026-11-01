import { z } from "zod";

import { EntityIdSchema, IsoDateTimeSchema } from "./primitives.js";

/**
 * Normalized fault taxonomy across vendors (spec adapter contract). Vendor
 * fault codes are mapped into exactly one of these by the adapter.
 */
export const FAULT_TYPES = [
  "BATTERY",
  "STUCK",
  "SENSOR_DEGRADED",
  "COMMS_LOST",
  "WEATHER_HOLD",
  "MAINTENANCE_DUE",
] as const;
export type FaultType = (typeof FAULT_TYPES)[number];
export const FaultTypeSchema = z.enum(FAULT_TYPES);

export const FAULT_SEVERITIES = ["info", "warning", "critical"] as const;
export type FaultSeverity = (typeof FAULT_SEVERITIES)[number];
export const FaultSeveritySchema = z.enum(FAULT_SEVERITIES);

/** One normalized fault event, ready for fleet-health classification. */
export const FaultEventSchema = z.strictObject({
  faultId: EntityIdSchema,
  robotId: EntityIdSchema,
  ts: IsoDateTimeSchema,
  type: FaultTypeSchema,
  severity: FaultSeveritySchema,
  message: z.string().min(1).max(2000),
  /** Set when the fault interrupted an active task. */
  taskId: EntityIdSchema.optional(),
  /** Adapter-provided detail, normalized to string values for the audit trail. */
  detail: z.record(z.string(), z.string()).optional(),
});

export type FaultEvent = z.infer<typeof FaultEventSchema>;
