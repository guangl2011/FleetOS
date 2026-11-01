import { ConstraintError } from "@fleetos/constraints";
import { FleetHealthError } from "@fleetos/fleet-health";
import { SchedulerError } from "@fleetos/scheduler";
import { AgentError } from "@fleetos/device-agents";
import {
  AdapterLifecycleError,
  AdapterNotConnectedError,
  CommandNotPermittedError,
  NormalizationError,
  UnknownRobotError,
} from "@fleetos/adapters-sdk";
import { MinimizationError } from "./minimization.js";

/**
 * Machine-readable API failures: status + code, never stringly. Domain
 * errors (typed code-first classes from each package) map to HTTP statuses
 * here — the API branches on codes, and the error handler owns the mapping
 * so handlers can throw package errors directly.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** Package error class → HTTP status. One row per failure surface. */
type ErrorMapper = (error: Error) => ApiError | null;

const mappers: readonly ErrorMapper[] = [
  (e) =>
    e instanceof FleetHealthError
      ? new ApiError(
          (
            {
              EXCEPTION_UNKNOWN: 404,
              EXCEPTION_INVALID_TRANSITION: 409,
              TASK_NOT_HELD: 409,
              INTERVENTION_INVALID: 400,
              AUDIT_EVENT_INVALID: 500,
            } as Record<string, number>
          )[e.code] ?? 500,
          e.code,
          e.message,
        )
      : null,
  (e) =>
    e instanceof ConstraintError
      ? new ApiError(
          (
            {
              PACK_PARSE_FAILED: 400,
              PACK_SEMANTIC: 422,
              PACK_UNAPPROVED: 422,
              PACK_SCOPE_INFEASIBLE: 422,
              PACK_VERSIONS_OVERLAP: 409,
              PACK_VERSION_WINDOW_INVALID: 422,
              PACK_INSTANT_INVALID: 400,
            } as Record<string, number>
          )[e.code] ?? 500,
          e.code,
          e.message,
          { ...(e.issues.length > 0 ? { issues: e.issues } : {}), ...(e.findings.length > 0 ? { findings: e.findings } : {}) },
        )
      : null,
  (e) =>
    e instanceof SchedulerError
      ? new ApiError(
          (
            {
              OBJECTIVE_INVALID: 422,
              CONTEXT_INVALID: 422,
              INPUT_INVALID: 422,
              ENVELOPE_BUILD_FAILED: 409,
            } as Record<string, number>
          )[e.code] ?? 500,
          e.code,
          e.message,
        )
      : null,
  (e) =>
    e instanceof AgentError
      ? new ApiError(
          (
            {
              ROBOT_MISMATCH: 409,
              ENVELOPE_MISMATCH: 409,
              DIAGNOSIS_MISMATCH: 404,
              APPROVAL_REQUIRED: 409,
              APPROVAL_ALREADY_USED: 409,
              AUDIT_EVENT_INVALID: 500,
            } as Record<string, number>
          )[e.code] ?? 500,
          e.code,
          e.message,
        )
      : null,
  (e) =>
    e instanceof MinimizationError
      ? new ApiError(
          // Minimization failures are policy, not server faults: the caller
          // sent telemetry the compliance config cannot accept.
          422,
          e.code,
          e.message,
          { ...(e.fields.length > 0 ? { fields: e.fields } : {}) },
        )
      : null,
  (e) =>
    e instanceof CommandNotPermittedError
      ? new ApiError(409, "COMMAND_NOT_PERMITTED", e.message)
      : null,
  (e) =>
    e instanceof AdapterNotConnectedError
      ? new ApiError(409, "ADAPTER_NOT_CONNECTED", e.message)
      : null,
  (e) => (e instanceof AdapterLifecycleError ? new ApiError(409, "ADAPTER_LIFECYCLE", e.message) : null),
  (e) => (e instanceof UnknownRobotError ? new ApiError(404, "ROBOT_UNKNOWN", e.message) : null),
  (e) =>
    e instanceof NormalizationError
      ? new ApiError(500, "NORMALIZATION_FAILED", e.message)
      : null,
];

/** Maps any thrown error to its API shape; unknown errors become 500s. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof Error) {
    for (const map of mappers) {
      const mapped = map(error);
      if (mapped !== null) {
        return mapped;
      }
    }
    return new ApiError(500, "INTERNAL", error.message);
  }
  return new ApiError(500, "INTERNAL", String(error));
}
