import type { ExternalConstraintPack, FaultEvent, Robot } from "@fleetos/core-schema";
import type { AssignedEnvelope } from "@fleetos/scheduler";
import { systemClock } from "@fleetos/world-model";
import type { DigitalShadowSlice, WorldClock } from "@fleetos/world-model";

import type { AgentAuditSink } from "./audit.js";
import type { AgentDiagnosis, DiagnosisBody } from "./diagnosis.js";
import { AgentError } from "./errors.js";
import { createDeterministicPolicy } from "./policy.js";
import type { AgentPolicy } from "./policy.js";
import { reviewReplanProposal } from "./replan.js";
import type {
  ReplanCandidate,
  ReplanProposal,
  ReplanReview,
  ReplanReviewContext,
} from "./replan.js";
import { commandableRecovery } from "./recovery.js";
import type {
  RecoveryCommand,
  RecoveryDecision,
  RecoveryDecisionInput,
  RecoveryResolution,
} from "./recovery.js";

/**
 * One agent per device (spec agentic operations): ground truth is this
 * robot's digital-shadow slice plus the envelope the scheduler assigned it
 * and the constraint packs in force. The agent observes, self-diagnoses
 * faults, proposes strictly envelope-bounded local replans, and routes every
 * recovery through the human-approved audited command path. It never holds
 * remote-driving authority — the only robot-facing object it can produce is
 * a recovery command from the dispatch surface (RESUME / DOCK_CHARGE), and
 * that only downstream of a recorded human approval.
 */
export interface DeviceAgent {
  readonly robotId: string;
  readonly agentId: string;
  readonly policy: AgentPolicy;
  /**
   * Re-grounds the agent. Pass `null` when the plan gave this robot no work
   * — fault diagnosis keeps working, local replanning yields nothing.
   */
  observe(
    slice: DigitalShadowSlice,
    envelope: AssignedEnvelope | null,
    packs: readonly ExternalConstraintPack[],
  ): void;
  /** Self-diagnosis of one normalized fault: severity + suggested recovery, audited. */
  reportFault(fault: FaultEvent): AgentDiagnosis;
  /** Drafts a policy candidate against the current ground truth, reviews it, audits it. */
  proposeLocalReplan(): { readonly proposal: ReplanProposal; readonly review: ReplanReview } | null;
  /** The general boundary: any complete proposal, from any source, reviewed + audited. */
  reviewProposal(proposal: ReplanProposal): ReplanReview;
  /** Records the operator's approve/reject decision on a diagnosis. Audited. */
  decideRecovery(input: RecoveryDecisionInput): RecoveryDecision;
  /** The audited command path — see recovery.ts. Throws without human approval. */
  issueRecoveryCommand(diagnosisId: string): RecoveryResolution;
}

export interface DeviceAgentInput {
  readonly robot: Robot;
  readonly audit: AgentAuditSink;
  readonly clock?: WorldClock;
  readonly policy?: AgentPolicy;
  /** Site timezone offset in minutes for local-clock hard-window checks; default 0 (UTC). */
  readonly localOffsetMinutes?: number;
}

/**
 * Builds one agent for one robot. Identity (the registry record — including
 * the capabilities diagnosis reads) is fixed at construction; ground truth
 * (slice, envelope, packs) arrives via observe. All ids are deterministic
 * counters — no wall-clock, no RNG, benchmark-reproducible.
 */
export function createDeviceAgent(input: DeviceAgentInput): DeviceAgent {
  const { robot, audit, policy = createDeterministicPolicy() } = input;
  const clock = input.clock ?? systemClock();
  const localOffsetMinutes = input.localOffsetMinutes ?? 0;
  const agentId = `agent-${robot.robotId}`;

  let slice: DigitalShadowSlice | null = null;
  let envelope: AssignedEnvelope | null = null;
  let packs: readonly ExternalConstraintPack[] = [];
  let proposalSeq = 0;
  let commandSeq = 0;
  const diagnoses = new Map<string, AgentDiagnosis>();
  const decisions = new Map<string, RecoveryDecision>();
  const consumed = new Set<string>();

  const requireOwnRobot = (candidateRobotId: string, what: string): void => {
    if (candidateRobotId !== robot.robotId) {
      throw new AgentError(
        "ROBOT_MISMATCH",
        `${what} names robot "${candidateRobotId}"; agent "${agentId}" owns "${robot.robotId}"`,
        { robotId: robot.robotId },
      );
    }
  };

  const reviewContext = (envelopeInForce: AssignedEnvelope | null): ReplanReviewContext => ({
    robotId: robot.robotId,
    envelope: envelopeInForce,
    packs,
    robotKind: robot.kind,
    localOffsetMinutes,
  });

  const stampCandidate = (
    candidate: ReplanCandidate,
    envelopeInForce: AssignedEnvelope,
    at: string,
  ): ReplanProposal => {
    proposalSeq += 1;
    return {
      ...candidate,
      proposalId: `prop-${robot.robotId}-${proposalSeq}`,
      robotId: robot.robotId,
      envelopeId: envelopeInForce.envelopeId,
      createdAt: at,
    };
  };

  const reviewAndAudit = (proposal: ReplanProposal, at: string): ReplanReview => {
    const review = reviewReplanProposal(proposal, reviewContext(envelope));
    audit.append({
      at,
      actorType: "device-agent",
      actorId: agentId,
      action: "agent-replan-proposal",
      subjectType: "agent-proposal",
      subjectId: proposal.proposalId,
      detail: {
        proposalKind: proposal.kind,
        review: review.accepted ? "accepted" : "rejected",
        ...(review.accepted ? {} : { rejectionCode: review.code }),
      },
    });
    return review;
  };

  return {
    robotId: robot.robotId,
    agentId,
    policy,

    observe(nextSlice, nextEnvelope, nextPacks): void {
      requireOwnRobot(nextSlice.robotId, "shadow slice");
      if (nextEnvelope !== null) {
        requireOwnRobot(nextEnvelope.robotId, "assigned envelope");
      }
      slice = nextSlice;
      envelope = nextEnvelope;
      packs = nextPacks;
    },

    reportFault(fault: FaultEvent): AgentDiagnosis {
      requireOwnRobot(fault.robotId, "fault event");
      const body: DiagnosisBody = policy.diagnose({ fault, robot, envelope });
      const diagnosis: AgentDiagnosis = {
        ...body,
        diagnosisId: `diag-${fault.faultId}`,
        ts: clock.now(),
      };
      diagnoses.set(diagnosis.diagnosisId, diagnosis);
      audit.append({
        at: diagnosis.ts,
        actorType: "device-agent",
        actorId: agentId,
        action: "agent-diagnosis",
        subjectType: "robot",
        subjectId: robot.robotId,
        detail: {
          diagnosisId: diagnosis.diagnosisId,
          faultId: fault.faultId,
          severity: diagnosis.severity,
          suggestedRecovery: diagnosis.suggestedRecovery.kind,
          selfClearing: String(diagnosis.selfClearing),
        },
      });
      return diagnosis;
    },

    proposeLocalReplan() {
      if (slice === null || envelope === null) {
        return null; // No ground truth or no assigned work — nothing bounded to propose.
      }
      const at = clock.now();
      const candidate = policy.proposeReplan({
        robot,
        slice,
        envelope,
        packs,
        now: at,
        localOffsetMinutes,
      });
      if (candidate === null) {
        return null;
      }
      const proposal = stampCandidate(candidate, envelope, at);
      const review = reviewAndAudit(proposal, at);
      return { proposal, review };
    },

    reviewProposal(proposal: ReplanProposal): ReplanReview {
      return reviewAndAudit(proposal, clock.now());
    },

    decideRecovery(decisionInput: RecoveryDecisionInput): RecoveryDecision {
      const diagnosis = diagnoses.get(decisionInput.diagnosisId);
      if (diagnosis === undefined) {
        throw new AgentError(
          "DIAGNOSIS_MISMATCH",
          `no diagnosis "${decisionInput.diagnosisId}" was issued by "${agentId}"`,
          { robotId: robot.robotId },
        );
      }
      if (consumed.has(decisionInput.diagnosisId)) {
        throw new AgentError(
          "APPROVAL_ALREADY_USED",
          `recovery for diagnosis "${decisionInput.diagnosisId}" is already resolved`,
          { robotId: robot.robotId },
        );
      }
      const at = clock.now();
      const decision: RecoveryDecision = {
        ...decisionInput,
        decisionId: `dec-${decisionInput.diagnosisId}-${decisions.size + 1}`,
        robotId: robot.robotId,
        at,
      };
      decisions.set(decisionInput.diagnosisId, decision);
      audit.append({
        at,
        actorType: "operator",
        actorId: decisionInput.operatorId,
        action: decisionInput.decision === "approve" ? "recovery-approved" : "recovery-rejected",
        subjectType: "agent-proposal",
        subjectId: decisionInput.diagnosisId,
        detail: { decisionId: decision.decisionId, reason: decisionInput.reason },
      });
      return decision;
    },

    issueRecoveryCommand(diagnosisId: string): RecoveryResolution {
      const diagnosis = diagnoses.get(diagnosisId);
      if (diagnosis === undefined) {
        throw new AgentError(
          "DIAGNOSIS_MISMATCH",
          `no diagnosis "${diagnosisId}" was issued by "${agentId}"`,
          {
            robotId: robot.robotId,
          },
        );
      }
      if (consumed.has(diagnosisId)) {
        throw new AgentError(
          "APPROVAL_ALREADY_USED",
          `recovery for diagnosis "${diagnosisId}" is already resolved`,
          {
            robotId: robot.robotId,
          },
        );
      }
      const decision = decisions.get(diagnosisId);
      if (decision === undefined || decision.decision !== "approve") {
        throw new AgentError(
          "APPROVAL_REQUIRED",
          `recovery for diagnosis "${diagnosisId}" has ${
            decision === undefined ? "no human decision" : "a rejected decision"
          } — no recovery command executes without human approval`,
          { robotId: robot.robotId },
        );
      }
      consumed.add(diagnosisId);
      const kind = diagnosis.suggestedRecovery.kind;
      const permission = commandableRecovery(kind);
      const at = clock.now();
      if (permission === null) {
        const reason = kind === "reassign" ? "scheduler-reassign" : "human-dispatch";
        audit.append({
          at,
          actorType: "system",
          actorId: agentId,
          action: "recovery-dispatch-requested",
          subjectType: "agent-proposal",
          subjectId: diagnosisId,
          detail: {
            diagnosisId,
            decisionId: decision.decisionId,
            recoveryKind: kind,
            operatorId: decision.operatorId,
            reason,
          },
        });
        return { kind: "no-command", reason };
      }
      commandSeq += 1;
      const command: RecoveryCommand = {
        commandId: `cmd-${robot.robotId}-${commandSeq}`,
        robotId: robot.robotId,
        diagnosisId,
        decisionId: decision.decisionId,
        kind,
        permission,
        issuedAt: at,
      };
      audit.append({
        at,
        actorType: "system",
        actorId: agentId,
        action: "recovery-command-issued",
        subjectType: "agent-proposal",
        subjectId: diagnosisId,
        detail: {
          diagnosisId,
          decisionId: decision.decisionId,
          commandId: command.commandId,
          permission,
          operatorId: decision.operatorId,
        },
      });
      return { kind: "command", command };
    },
  };
}
