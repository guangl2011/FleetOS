import { z } from "zod";

import { TaskTypeSchema } from "./capability.js";
import { EntityIdSchema, IsoDateTimeSchema, SchemaVersionSchema } from "./primitives.js";

export const TASK_STATUSES = [
  "pending",
  "scheduled",
  "in-progress",
  "held",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const TaskRequirementsSchema = z.strictObject({
  /** Robot is schedulable iff capability.taskTypes ⊇ requirements.taskTypes. */
  taskTypes: z.array(TaskTypeSchema).min(1),
});

export const TaskWindowSchema = z
  .strictObject({
    notBefore: IsoDateTimeSchema,
    notAfter: IsoDateTimeSchema,
    // Zod-only invariant (not expressible in JSON Schema): notBefore <= notAfter,
    // compared as instants to tolerate mixed UTC offsets.
  })
  .refine((window) => Date.parse(window.notBefore) <= Date.parse(window.notAfter), {
    message: "window.notBefore must be at or before window.notAfter",
  });

/**
 * One unit of schedulable work. Constraint packs may narrow the SLA window
 * further; the task record itself carries only what the customer asked for.
 */
export const FleetTaskSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  taskId: EntityIdSchema,
  siteId: EntityIdSchema,
  requirements: TaskRequirementsSchema,
  /** Customer SLA window. */
  window: TaskWindowSchema,
  /** Scheduling priority 1-100; higher = more important. */
  priority: z.number().int().min(1).max(100),
  status: TaskStatusSchema,
});

export type FleetTask = z.infer<typeof FleetTaskSchema>;
