import { z } from "zod";

import {
  ConfidenceSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  PercentSchema,
  SchemaVersionSchema,
} from "./primitives.js";

/** One assignment inside a dispatch plan (spec DispatchPlan.assignments item). */
export const ScheduleEntrySchema = z.strictObject({
  robotId: EntityIdSchema,
  taskId: EntityIdSchema,
  startAt: IsoDateTimeSchema,
  estMinutes: z.number().positive(),
  /** Explainability for the operator: why this assignment carries risk. */
  riskNotes: z.array(z.string().min(1).max(500)),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const PlanProjectionsSchema = z.strictObject({
  /** Modeled expected on-time completion fraction in [0, 1]. */
  onTimeCompletion: ConfidenceSchema,
  expectedInterventions: z.number().min(0),
  minBatteryReservePct: PercentSchema,
});

/**
 * The output of the scheduling core (spec D1): a candidate dispatch plan with
 * its projected quality, consumable by the operator console before commit.
 */
export const DispatchPlanSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  planId: EntityIdSchema,
  createdAt: IsoDateTimeSchema,
  /** Empty when nothing is schedulable — a valid, reportable outcome. */
  assignments: z.array(ScheduleEntrySchema),
  projected: PlanProjectionsSchema,
});

export type DispatchPlan = z.infer<typeof DispatchPlanSchema>;
