import type { InfeasibleScopeFinding } from "./coverage.js";
import type { PackIssue } from "./validate.js";

/**
 * Machine-readable failure codes for every refusal this package can produce.
 * The console and the scheduler branch on these, never on error text.
 */
export type ConstraintErrorCode =
  | "PACK_PARSE_FAILED"
  | "PACK_SEMANTIC"
  | "PACK_UNAPPROVED"
  | "PACK_SCOPE_INFEASIBLE"
  | "PACK_VERSIONS_OVERLAP"
  | "PACK_VERSION_WINDOW_INVALID"
  | "PACK_INSTANT_INVALID";

export interface ConstraintErrorOptions {
  readonly packId?: string;
  readonly issues?: readonly PackIssue[];
  readonly findings?: readonly InfeasibleScopeFinding[];
}

/** The single error type thrown by every public function in this package. */
export class ConstraintError extends Error {
  readonly code: ConstraintErrorCode;
  readonly packId: string | undefined;
  readonly issues: readonly PackIssue[];
  readonly findings: readonly InfeasibleScopeFinding[];

  constructor(code: ConstraintErrorCode, message: string, options: ConstraintErrorOptions = {}) {
    super(message);
    this.name = "ConstraintError";
    this.code = code;
    this.packId = options.packId;
    this.issues = options.issues ?? [];
    this.findings = options.findings ?? [];
  }
}
