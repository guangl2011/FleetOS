import { z } from "zod";

import { EntityIdSchema, IsoDateTimeSchema } from "./primitives.js";

/**
 * A recorded human touch on the fleet. RaaS economics count these (docx §7:
 * −20% interventions per 100 robot-hours is the benchmark bar); the remote
 * surface is pause/resume/reassign plus device-agent proposal decisions —
 * never teleoperation (spec non-goal guardrail).
 */
export const INTERVENTION_KINDS = [
  "pause",
  "resume",
  "reassign",
  "approve-recovery",
  "reject-proposal",
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];
export const InterventionKindSchema = z.enum(INTERVENTION_KINDS);

export const InterventionSchema = z.strictObject({
  interventionId: EntityIdSchema,
  ts: IsoDateTimeSchema,
  robotId: EntityIdSchema,
  taskId: EntityIdSchema.optional(),
  kind: InterventionKindSchema,
  operatorId: EntityIdSchema,
  reason: z.string().min(1).max(2000),
  /** Plan version in effect when the intervention happened. */
  planId: EntityIdSchema.optional(),
});

export type Intervention = z.infer<typeof InterventionSchema>;
