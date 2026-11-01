/**
 * Machine-readable failure codes for every refusal this package can produce.
 * The console and the API branch on these, never on error text.
 */
export type FleetHealthErrorCode =
  /** An exception id was not found in the queue. */
  | "EXCEPTION_UNKNOWN"
  /** A lifecycle transition the exception's current status does not allow. */
  | "EXCEPTION_INVALID_TRANSITION"
  /** A task was released while it was not held. */
  | "TASK_NOT_HELD"
  /** An intervention record failed the core-schema Intervention schema. */
  | "INTERVENTION_INVALID"
  /** An audit draft failed the core-schema AuditEvent schema. */
  | "AUDIT_EVENT_INVALID";

/** The single error type thrown by every public function in this package. */
export class FleetHealthError extends Error {
  readonly code: FleetHealthErrorCode;

  constructor(code: FleetHealthErrorCode, message: string) {
    super(message);
    this.name = "FleetHealthError";
    this.code = code;
  }
}
