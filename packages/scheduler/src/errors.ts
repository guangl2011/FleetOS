/**
 * Typed error for scheduler contract violations — code-first, never stringly.
 * Constraint-pack refusals propagate as the constraints package's typed
 * `ConstraintError` (the ingestion seam owns that gate); SchedulerError is
 * for everything this package validates itself.
 */
export type SchedulerErrorCode =
  "OBJECTIVE_INVALID" | "CONTEXT_INVALID" | "INPUT_INVALID" | "ENVELOPE_BUILD_FAILED";

/** The single error type thrown by every public function in this package. */
export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
  }
}
