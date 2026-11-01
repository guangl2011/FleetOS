import { FAULT_TYPES } from "@fleetos/core-schema";
import type { FaultEvent, FaultSeverity, FaultType } from "@fleetos/core-schema";
import type { AgentDiagnosis, RecoveryKind } from "@fleetos/device-agents";

/**
 * Fault severity classification (spec fleet-health chapter): pure mapping
 * from the six normalized fault classes to the actions fleet-health takes —
 * open an exception, hold the affected task, mark the robot DEGRADED, and
 * auto-clear on fresh telemetry. Fed by adapter fault profiles (a FaultEvent)
 * and refined by device-agent diagnoses (an AgentDiagnosis escalates severity
 * and contributes the suggested recovery); the agent never drives this
 * classification — its diagnosis is advisory input, and recovery stays
 * human-approved downstream.
 */

const SEVERITY_RANK: Record<FaultSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function maxSeverity(a: FaultSeverity, b: FaultSeverity): FaultSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Per-class response policy. Defaults follow the design doc: every fault
 * class opens an exception (the console triages by severity); BATTERY,
 * STUCK, and COMMS_LOST hold the affected task (the robot cannot be trusted
 * to continue it); only COMMS_LOST marks the robot DEGRADED, and only a
 * COMMS_LOST exception auto-releases on fresh telemetry — the sample itself
 * proves the link back, whereas battery/stuck recovery requires a human.
 */
export interface ClassificationPolicy {
  /** Fault classes that open an exception in the queue. */
  readonly exceptionFaults: ReadonlySet<FaultType>;
  /** Fault classes that hold the affected task in HELD. */
  readonly holdFaults: ReadonlySet<FaultType>;
  /** Fault classes that mark the robot DEGRADED (telemetry excluded from optimization). */
  readonly degradedFaults: ReadonlySet<FaultType>;
  /** Fault classes whose exception auto-releases when fresh telemetry arrives. */
  readonly telemetryClearedFaults: ReadonlySet<FaultType>;
}

export const DEFAULT_CLASSIFICATION_POLICY: ClassificationPolicy = {
  exceptionFaults: new Set<FaultType>(FAULT_TYPES),
  holdFaults: new Set<FaultType>(["BATTERY", "STUCK", "COMMS_LOST"]),
  degradedFaults: new Set<FaultType>(["COMMS_LOST"]),
  telemetryClearedFaults: new Set<FaultType>(["COMMS_LOST"]),
};

export interface FaultClassification {
  readonly faultId: string;
  readonly robotId: string;
  readonly taskId: string | undefined;
  readonly type: FaultType;
  /** Final severity: the adapter's, escalated by the device-agent diagnosis when present. */
  readonly severity: FaultSeverity;
  readonly opensException: boolean;
  readonly holdsTask: boolean;
  readonly marksDegraded: boolean;
  /** Whether a fresh telemetry sample auto-releases the exception (COMMS_LOST only). */
  readonly clearsOnTelemetry: boolean;
  /** The diagnosis' suggested recovery, when a diagnosis fed the classification. */
  readonly suggestedRecovery: RecoveryKind | null;
  /** One-line, operator-facing reason for the classification. */
  readonly rationale: string;
}

export interface ClassifyOptions {
  readonly policy?: ClassificationPolicy;
  readonly diagnosis?: AgentDiagnosis;
}

export function classifyFault(
  fault: FaultEvent,
  options: ClassifyOptions = {},
): FaultClassification {
  const policy = options.policy ?? DEFAULT_CLASSIFICATION_POLICY;
  const diagnosis = options.diagnosis;
  const severity = diagnosis ? maxSeverity(fault.severity, diagnosis.severity) : fault.severity;
  const opensException = policy.exceptionFaults.has(fault.type);
  const holdsTask = policy.holdFaults.has(fault.type);
  const marksDegraded = policy.degradedFaults.has(fault.type);
  const clearsOnTelemetry = policy.telemetryClearedFaults.has(fault.type);
  const notes = [
    diagnosis
      ? `device-agent diagnosis "${diagnosis.diagnosisId}" escalates severity and suggests ${diagnosis.suggestedRecovery.kind}`
      : "no device-agent diagnosis yet",
    clearsOnTelemetry ? "auto-clears on fresh telemetry" : "requires human resolution",
  ];
  return {
    faultId: fault.faultId,
    robotId: fault.robotId,
    taskId: fault.taskId,
    type: fault.type,
    severity,
    opensException,
    holdsTask,
    marksDegraded,
    clearsOnTelemetry,
    suggestedRecovery: diagnosis?.suggestedRecovery.kind ?? null,
    rationale: `${fault.type} (severity ${severity}): ${notes.join("; ")}`,
  };
}
