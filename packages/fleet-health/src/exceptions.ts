import { z } from "zod";

import {
  EntityIdSchema,
  FaultSeveritySchema,
  FaultTypeSchema,
  IsoDateTimeSchema,
} from "@fleetos/core-schema";
import { RECOVERY_KINDS } from "@fleetos/device-agents";

/**
 * The exception queue (spec fleet-health chapter): one operator-visible
 * exception per classified fault, opened by the engine and resolved through
 * acknowledge → release. The record is package-local (core-schema carries
 * the cross-package contracts — fault, intervention, audit — while the
 * exception lifecycle is fleet-health's own surface).
 */

export const EXCEPTION_STATUSES = ["open", "acknowledged", "released"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export const ExceptionStatusSchema = z.enum(EXCEPTION_STATUSES);

export const ExceptionRecordSchema = z.strictObject({
  exceptionId: EntityIdSchema,
  /** The normalized fault that opened this exception (1:1, idempotent on faultId). */
  faultId: EntityIdSchema,
  robotId: EntityIdSchema,
  /** The task the fault affected — from the fault itself or the robot's assignment. */
  taskId: EntityIdSchema.optional(),
  type: FaultTypeSchema,
  severity: FaultSeveritySchema,
  message: z.string().min(1).max(2000),
  status: ExceptionStatusSchema,
  openedAt: IsoDateTimeSchema,
  acknowledgedAt: IsoDateTimeSchema.optional(),
  releasedAt: IsoDateTimeSchema.optional(),
  /** Why the exception was released (operator reason or system auto-release). */
  releasedReason: z.string().min(1).max(2000).optional(),
  /** True when the fault put the robot in degraded mode (its telemetry is excluded). */
  marksDegraded: z.boolean(),
  /** Suggested recovery recorded from the device-agent diagnosis, when one arrived. */
  suggestedRecovery: z.enum(RECOVERY_KINDS).optional(),
});

export type ExceptionRecord = z.infer<typeof ExceptionRecordSchema>;
