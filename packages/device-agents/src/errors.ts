/**
 * Machine-readable failure codes for every refusal this package can produce.
 * The console and the API branch on these, never on error text.
 */
export type AgentErrorCode =
  /** An event or record named a robot this agent does not own. */
  | "ROBOT_MISMATCH"
  /** A proposal named an envelope other than the one the agent holds. */
  | "ENVELOPE_MISMATCH"
  /** A recovery decision referenced a diagnosis this agent never issued. */
  | "DIAGNOSIS_MISMATCH"
  /** A recovery command was attempted without a recorded human approval. */
  | "APPROVAL_REQUIRED"
  /** A diagnosis's recovery was already resolved — approvals are single-use. */
  | "APPROVAL_ALREADY_USED"
  /** An audit draft failed the core-schema AuditEvent schema. */
  | "AUDIT_EVENT_INVALID";

export interface AgentErrorOptions {
  readonly robotId?: string;
}

/** The single error type thrown by every public function in this package. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly robotId: string | undefined;

  constructor(code: AgentErrorCode, message: string, options: AgentErrorOptions = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.robotId = options.robotId;
  }
}
