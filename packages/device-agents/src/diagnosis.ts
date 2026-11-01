import type { FaultEvent, FaultSeverity, FaultType, Robot } from "@fleetos/core-schema";
import type { AssignedEnvelope } from "@fleetos/scheduler";

/**
 * The recovery vocabulary an agent may suggest — a bounded local set that
 * maps onto the remote surface the spec allows (pause/resume/reassign; the
 * dock command for chargeable robots). A diagnosis never carries a command,
 * only a suggestion; execution goes through the human-approved audited
 * command path (recovery.ts), never directly from a diagnosis.
 */
export const RECOVERY_KINDS = ["resume", "dock-charge", "reassign", "human-service"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export interface AgentDiagnosis {
  readonly diagnosisId: string;
  readonly faultId: string;
  readonly robotId: string;
  readonly ts: string;
  readonly severity: FaultSeverity;
  readonly summary: string;
  readonly suggestedRecovery: {
    readonly kind: RecoveryKind;
    readonly rationale: string;
  };
  /** True when the fault is expected to clear with no action (e.g. weather holds). */
  readonly selfClearing: boolean;
}

/**
 * What a policy returns: the diagnosis without its identity — the agent
 * stamps `diagnosisId` (fault-derived, so re-diagnosing one fault is
 * idempotent) and `ts` (the injected clock), then audits the result.
 */
export type DiagnosisBody = Omit<AgentDiagnosis, "diagnosisId" | "ts">;

const SEVERITY_RANK: Record<FaultSeverity, number> = { info: 0, warning: 1, critical: 2 };

const RECOVERY_RATIONALE: Record<RecoveryKind, string> = {
  resume: "transient condition; resume work once it clears (human-approved command)",
  "dock-charge":
    "battery below the safe reserve; send the robot to its dock (human-approved command)",
  reassign: "keep the task moving by moving it to another robot (scheduler action, human-approved)",
  "human-service": "on-site human service is required; no remote command can clear this fault",
};

/**
 * Recovery per fault class (spec fault taxonomy): BATTERY needs a dock or a
 * human depending on whether the robot can be commanded at all; STUCK is
 * always physical; degraded sensing resumes with monitoring; comms loss
 * resumes when the link returns unless the robot needs on-site help;
 * weather holds clear on their own; maintenance due moves the task.
 */
export function suggestedRecoveryKind(type: FaultType, remoteResume: boolean): RecoveryKind {
  switch (type) {
    case "BATTERY":
      return remoteResume ? "dock-charge" : "human-service";
    case "STUCK":
      return "human-service";
    case "SENSOR_DEGRADED":
      return "resume";
    case "COMMS_LOST":
      return remoteResume ? "resume" : "human-service";
    case "WEATHER_HOLD":
      return "resume";
    case "MAINTENANCE_DUE":
      return "reassign";
  }
}

/**
 * Severity escalates to critical when a human-touch-class fault (BATTERY,
 * STUCK — the scheduler's needsHumanTouch classes) interrupts the robot's
 * assigned task; otherwise the adapter-normalized severity stands.
 */
export function escalatedSeverity(
  fault: FaultEvent,
  envelope: AssignedEnvelope | null,
): FaultSeverity {
  const interruptsAssignedTask =
    envelope !== null && fault.taskId !== undefined && fault.taskId === envelope.taskId;
  const humanTouchClass = fault.type === "BATTERY" || fault.type === "STUCK";
  if (
    interruptsAssignedTask &&
    humanTouchClass &&
    SEVERITY_RANK[fault.severity] < SEVERITY_RANK.critical
  ) {
    return "critical";
  }
  return fault.severity;
}

/** The deterministic v1 diagnosis: severity + one suggested recovery from the bounded kind set. */
export function diagnoseFault(
  fault: FaultEvent,
  robot: Robot,
  envelope: AssignedEnvelope | null,
): DiagnosisBody {
  const severity = escalatedSeverity(fault, envelope);
  const kind = suggestedRecoveryKind(fault.type, robot.capabilities.remoteResume);
  return {
    faultId: fault.faultId,
    robotId: fault.robotId,
    severity,
    summary: `${fault.type} on ${fault.robotId}: ${fault.message}`,
    suggestedRecovery: { kind, rationale: RECOVERY_RATIONALE[kind] },
    selfClearing: fault.type === "WEATHER_HOLD",
  };
}
