import { z } from "zod";

import { EntityIdSchema, IsoDateTimeSchema } from "./primitives.js";

export const AUDIT_ACTOR_TYPES = ["operator", "system", "scheduler", "device-agent"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

export const AUDIT_SUBJECT_TYPES = [
  "robot",
  "task",
  "plan",
  "exception",
  "agent-proposal",
  "constraint-pack",
] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];
export const AuditSubjectTypeSchema = z.enum(AUDIT_SUBJECT_TYPES);

/**
 * One append-only audit entry. Producers append in seq order and never edit
 * history; the trail doubles as the compliance/incident evidence base (spec
 * data-compliance chapter) and audits every device-agent proposal.
 */
export const AuditEventSchema = z.strictObject({
  /** Monotonic append position (1-based). */
  seq: z.number().int().min(1),
  at: IsoDateTimeSchema,
  actorType: AuditActorTypeSchema,
  actorId: EntityIdSchema,
  action: z.string().min(1).max(128),
  subjectType: AuditSubjectTypeSchema,
  subjectId: EntityIdSchema,
  /** Plan version in effect at append time, when one exists. */
  planId: EntityIdSchema.optional(),
  detail: z.record(z.string(), z.string()).optional(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
