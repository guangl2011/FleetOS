import type { ExternalConstraintPack, HardConstraint, RobotKind } from "@fleetos/core-schema";
import { applicableHardConstraints, intervalForbidden } from "@fleetos/scheduler";
import type { AssignedEnvelope } from "@fleetos/scheduler";

/**
 * Replan proposals (spec agentic operations): the only two local moves a
 * device agent may propose — reordering tasks inside its own swap set, or
 * shifting its assigned task's start within tolerance. Anything else is
 * rejected here at runtime (and is unrepresentable at the type level: the
 * union has no third variant). Proposals are records, never actions — the
 * scheduler stays the global coordinator and recovery stays human-gated.
 */
export interface SwapTasksProposal {
  readonly kind: "swap-tasks";
  readonly proposalId: string;
  readonly robotId: string;
  readonly envelopeId: string;
  readonly createdAt: string;
  readonly taskIdA: string;
  readonly taskIdB: string;
  readonly reason: string;
}

export interface ShiftStartProposal {
  readonly kind: "shift-start";
  readonly proposalId: string;
  readonly robotId: string;
  readonly envelopeId: string;
  readonly createdAt: string;
  readonly taskId: string;
  readonly newStartAt: string;
  readonly reason: string;
}

export type ReplanProposal = SwapTasksProposal | ShiftStartProposal;

/**
 * A policy's draft proposal, before the agent stamps identity (robot,
 * envelope, ids, createdAt) and audits it. Policies never emit complete
 * proposals — identity is the agent's, so a policy cannot spoof another
 * robot's envelope.
 */
export type ReplanCandidate =
  | {
      readonly kind: "swap-tasks";
      readonly taskIdA: string;
      readonly taskIdB: string;
      readonly reason: string;
    }
  | {
      readonly kind: "shift-start";
      readonly taskId: string;
      readonly newStartAt: string;
      readonly reason: string;
    };

export type ReplanRejectionCode =
  | "ROBOT_MISMATCH"
  | "ENVELOPE_UNKNOWN"
  | "ENVELOPE_MISMATCH"
  | "SWAP_OUTSIDE_ENVELOPE"
  | "SWAP_TASKS_IDENTICAL"
  | "TASK_OUTSIDE_ENVELOPE"
  | "SHIFT_EXCEEDS_TOLERANCE"
  | "START_TIME_INVALID"
  | "HARD_WINDOW_CONFLICT";

export type ReplanReview =
  | { readonly accepted: true; readonly proposalId: string }
  | {
      readonly accepted: false;
      readonly proposalId: string;
      readonly code: ReplanRejectionCode;
      readonly message: string;
    };

export interface ReplanReviewContext {
  /** The reviewing agent's robot id — proposals for other robots are rejected. */
  readonly robotId: string;
  /** The envelope in force; null when the robot has no assigned work. */
  readonly envelope: AssignedEnvelope | null;
  readonly packs: readonly ExternalConstraintPack[];
  readonly robotKind: RobotKind;
  /** Site timezone offset in minutes for local-clock hard-window checks. */
  readonly localOffsetMinutes: number;
}

function rejected(
  proposal: ReplanProposal,
  code: ReplanRejectionCode,
  message: string,
): ReplanReview {
  return { accepted: false, proposalId: proposal.proposalId, code, message };
}

/** The task ids this envelope lets the agent touch: its assigned task plus its swap set. */
export function envelopeScope(envelope: AssignedEnvelope): ReadonlySet<string> {
  return new Set([envelope.taskId, ...envelope.swappableTaskIds]);
}

/**
 * Whether the shifted work interval (same duration as assigned) touches any
 * time-window hard constraint from packs that apply to the envelope's site
 * and robot kind. Weather-cutoff constraints stay the scheduler's
 * planning-time gate — the agent can only verify local-clock windows from
 * the packs it holds.
 */
export function shiftConflictsWithHardWindows(
  newStartMs: number,
  durationMs: number,
  packs: readonly ExternalConstraintPack[],
  siteId: string,
  robotKind: RobotKind,
  localOffsetMinutes: number,
): boolean {
  const windows = applicableHardConstraints(packs, { siteId, robotKind })
    .filter(
      (constraint): constraint is Extract<HardConstraint, { rule: "time-window" }> =>
        constraint.rule === "time-window",
    )
    .flatMap((constraint) => constraint.forbiddenWindows);
  if (windows.length === 0) {
    return false;
  }
  return intervalForbidden(newStartMs, newStartMs + durationMs, windows, localOffsetMinutes);
}

/**
 * The single envelope boundary every proposal passes — the agent's own
 * policy output and any external proposal (console replay, a Phase I policy)
 * go through this one reviewer. Order of checks: identity first, then
 * envelope binding, then the kind-specific bound.
 */
export function reviewReplanProposal(
  proposal: ReplanProposal,
  context: ReplanReviewContext,
): ReplanReview {
  const envelope = context.envelope;
  if (proposal.robotId !== context.robotId) {
    return rejected(
      proposal,
      "ROBOT_MISMATCH",
      `proposal targets robot "${proposal.robotId}" but the agent owns "${context.robotId}"`,
    );
  }
  if (envelope === null) {
    return rejected(
      proposal,
      "ENVELOPE_UNKNOWN",
      "the agent holds no assigned envelope to replan within",
    );
  }
  if (proposal.envelopeId !== envelope.envelopeId) {
    return rejected(
      proposal,
      "ENVELOPE_MISMATCH",
      `proposal names envelope "${proposal.envelopeId}" but the agent holds "${envelope.envelopeId}"`,
    );
  }
  if (proposal.kind === "swap-tasks") {
    if (proposal.taskIdA === proposal.taskIdB) {
      return rejected(proposal, "SWAP_TASKS_IDENTICAL", "a swap needs two distinct tasks");
    }
    const scope = envelopeScope(envelope);
    if (!scope.has(proposal.taskIdA) || !scope.has(proposal.taskIdB)) {
      return rejected(
        proposal,
        "SWAP_OUTSIDE_ENVELOPE",
        "both swap tasks must be the assigned task or in the envelope's swap set",
      );
    }
    return { accepted: true, proposalId: proposal.proposalId };
  }
  if (proposal.taskId !== envelope.taskId) {
    return rejected(
      proposal,
      "TASK_OUTSIDE_ENVELOPE",
      `only the assigned task "${envelope.taskId}" may shift, not "${proposal.taskId}"`,
    );
  }
  const assignedStartMs = Date.parse(envelope.assignedStartAt);
  const newStartMs = Date.parse(proposal.newStartAt);
  const durationMs = Date.parse(envelope.assignedEndAt) - assignedStartMs;
  if (!Number.isFinite(assignedStartMs) || !Number.isFinite(newStartMs) || durationMs <= 0) {
    return rejected(proposal, "START_TIME_INVALID", "envelope or proposal timestamps do not parse");
  }
  if (Math.abs(newStartMs - assignedStartMs) > envelope.shiftToleranceMinutes * 60_000) {
    return rejected(
      proposal,
      "SHIFT_EXCEEDS_TOLERANCE",
      `shift exceeds the envelope's ±${envelope.shiftToleranceMinutes} min tolerance`,
    );
  }
  if (
    shiftConflictsWithHardWindows(
      newStartMs,
      durationMs,
      context.packs,
      envelope.siteId,
      context.robotKind,
      context.localOffsetMinutes,
    )
  ) {
    return rejected(
      proposal,
      "HARD_WINDOW_CONFLICT",
      "the shifted work interval overlaps a forbidden time window from an active constraint pack",
    );
  }
  return { accepted: true, proposalId: proposal.proposalId };
}
