import { InterventionSchema } from "@fleetos/core-schema";
import type { FaultEvent, Intervention, TaskStatus, TelemetrySample } from "@fleetos/core-schema";
import { systemClock } from "@fleetos/world-model";
import type { WorldClock } from "@fleetos/world-model";
import type { AgentDiagnosis } from "@fleetos/device-agents";

import { createInMemoryAuditLog } from "./audit.js";
import type { AuditLog } from "./audit.js";
import { classifyFault, DEFAULT_CLASSIFICATION_POLICY } from "./classify.js";
import type { ClassificationPolicy, FaultClassification } from "./classify.js";
import { createDegradedModeTracker } from "./degraded.js";
import type { HealthState } from "./degraded.js";
import { FleetHealthError } from "./errors.js";
import { ExceptionRecordSchema } from "./exceptions.js";
import type { ExceptionRecord } from "./exceptions.js";

/**
 * The fleet-health engine (spec fleet-health chapter): wires classification,
 * the exception queue, the audit trail, and degraded mode into one ingest
 * surface. Adapter fault streams (subscribeFaults) feed ingestFault; the
 * telemetry stream feeds ingestTelemetry, which admits or excludes samples
 * for optimization (the scheduler consumes admitTelemetry's result); device
 * agents feed recordDiagnosis; the operator console drives the intervention
 * surface and exception lifecycle. Every state change appends exactly one
 * audit entry — operator command, system action, timestamp, plan version in
 * effect.
 *
 * The engine holds no vendor code and no robot control: it observes
 * normalized events and proposes work-state changes (HELD). Robot-local
 * safety stays authoritative; the remote surface here is pause/resume/
 * reassign bookkeeping, never teleoperation.
 */

/** The operator console's intervention input — the engine stamps id and ts. */
export interface InterventionInput {
  readonly robotId: string;
  readonly kind: Intervention["kind"];
  readonly operatorId: string;
  readonly reason: string;
  readonly taskId?: string;
  /** Plan version in effect — lands on the audit entry (spec audit-trail requirement). */
  readonly planId?: string;
}

export interface FaultIngestResult {
  readonly classification: FaultClassification;
  /** The exception opened for this fault; null when the policy declines it. */
  readonly exception: ExceptionRecord | null;
}

export interface TelemetryIngestResult {
  /** False when the robot is DEGRADED — the scheduler must not use this sample. */
  readonly admitted: boolean;
  /** True when this sample restored a DEGRADED link (COMMS_LOST auto-release). */
  readonly linkRestored: boolean;
}

export interface FleetHealthEngineOptions {
  /** Defaults to the system clock; simulators and tests inject the scenario clock. */
  readonly clock?: WorldClock;
  /** Defaults to an in-memory log; apps/api provides the persistent one. */
  readonly audit?: AuditLog;
  /** Defaults to the design-doc classification policy. */
  readonly policy?: ClassificationPolicy;
}

export interface FleetHealthEngine {
  /** The append-only audit trail — the compliance evidence base. */
  readonly audit: AuditLog;

  // ---- ingestion (adapter streams / device agents) ----
  ingestFault(fault: FaultEvent): FaultIngestResult;
  ingestTelemetry(sample: TelemetrySample): TelemetryIngestResult;
  /** Refines the matching exception with the agent's severity + suggested recovery. */
  recordDiagnosis(diagnosis: AgentDiagnosis): ExceptionRecord | null;

  // ---- operator surface ----
  recordIntervention(input: InterventionInput): Intervention;
  acknowledgeException(exceptionId: string, operatorId: string): ExceptionRecord;
  releaseException(exceptionId: string, operatorId: string, reason: string): ExceptionRecord;

  // ---- task-state tracking (fed from committed plans) ----
  /** Attributes an open task to a robot (e.g. when a plan commits). */
  assignTask(robotId: string, taskId: string): void;
  taskStatus(taskId: string): TaskStatus | null;
  heldTasks(): readonly string[];

  // ---- reads ----
  exceptions(): readonly ExceptionRecord[];
  openExceptions(): readonly ExceptionRecord[];
  exception(exceptionId: string): ExceptionRecord;
  interventions(): readonly Intervention[];
  healthOf(robotId: string): HealthState;
  degradedRobots(): ReadonlySet<string>;
  admitTelemetry(sample: TelemetrySample): boolean;
}

interface TaskRecord {
  readonly taskId: string;
  robotId: string | null;
  status: TaskStatus;
  /** Status to restore when the hold releases (null while not held). */
  statusBeforeHold: TaskStatus | null;
}

export function createFleetHealthEngine(options: FleetHealthEngineOptions = {}): FleetHealthEngine {
  const clock = options.clock ?? systemClock();
  const audit = options.audit ?? createInMemoryAuditLog();
  const policy = options.policy ?? DEFAULT_CLASSIFICATION_POLICY;
  const degraded = createDegradedModeTracker();

  const exceptionById = new Map<string, ExceptionRecord>();
  const exceptionIdByFault = new Map<string, string>();
  /** Tasks this exception holds — released when the exception releases. */
  const heldByException = new Map<string, string[]>();
  const tasks = new Map<string, TaskRecord>();
  const taskOfRobot = new Map<string, string>();
  const interventions: Intervention[] = [];
  let exceptionSeq = 0;
  let interventionSeq = 0;

  const now = () => clock.now();

  const requireException = (exceptionId: string): ExceptionRecord => {
    const record = exceptionById.get(exceptionId);
    if (!record) {
      throw new FleetHealthError("EXCEPTION_UNKNOWN", `no exception "${exceptionId}" in the queue`);
    }
    return record;
  };

  const saveException = (record: ExceptionRecord): ExceptionRecord => {
    const parsed = ExceptionRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new FleetHealthError(
        "EXCEPTION_INVALID_TRANSITION",
        `exception "${record.exceptionId}" update failed the ExceptionRecord schema: ${parsed.error.message}`,
      );
    }
    exceptionById.set(record.exceptionId, parsed.data);
    return parsed.data;
  };

  // ---- task state ----

  const registerTask = (taskId: string, robotId: string | null, status: TaskStatus): TaskRecord => {
    const existing = tasks.get(taskId);
    if (existing) {
      if (robotId !== null && existing.robotId === null) existing.robotId = robotId;
      return existing;
    }
    const record: TaskRecord = { taskId, robotId, status, statusBeforeHold: null };
    tasks.set(taskId, record);
    return record;
  };

  const holdTask = (taskId: string): boolean => {
    const record = registerTask(taskId, null, "in-progress");
    if (record.status === "held") return false; // already held by an earlier exception
    record.statusBeforeHold = record.status;
    record.status = "held";
    return true;
  };

  const releaseTask = (taskId: string): void => {
    const record = tasks.get(taskId);
    if (!record || record.status !== "held") {
      throw new FleetHealthError(
        "TASK_NOT_HELD",
        `task "${taskId}" cannot be released: it is not held`,
      );
    }
    record.status = record.statusBeforeHold ?? "scheduled";
    record.statusBeforeHold = null;
  };

  const releaseExceptionTasks = (exceptionId: string, at: string): void => {
    for (const taskId of heldByException.get(exceptionId) ?? []) {
      releaseTask(taskId);
      const record = tasks.get(taskId);
      audit.append({
        at,
        actorType: "system",
        actorId: "fleet-health",
        action: "task-released",
        subjectType: "task",
        subjectId: taskId,
        detail: { exceptionId, restoredStatus: record?.status ?? "scheduled" },
      });
    }
    heldByException.delete(exceptionId);
  };

  return {
    audit,

    ingestFault(fault: FaultEvent): FaultIngestResult {
      const at = now();

      // Idempotent per faultId: a replayed fault never double-opens or double-audits.
      const existingId = exceptionIdByFault.get(fault.faultId);
      if (existingId !== undefined) {
        return {
          classification: classifyFault(fault, { policy }),
          exception: exceptionById.get(existingId) ?? null,
        };
      }

      const classification = classifyFault(fault, { policy });
      audit.append({
        at,
        actorType: "system",
        actorId: "fleet-health",
        action: "fault-ingested",
        subjectType: "robot",
        subjectId: fault.robotId,
        detail: {
          faultId: fault.faultId,
          type: fault.type,
          severity: classification.severity,
          rationale: classification.rationale,
        },
      });

      if (!classification.opensException) {
        return { classification, exception: null };
      }

      const taskId = fault.taskId ?? taskOfRobot.get(fault.robotId);
      exceptionSeq += 1;
      let exception: ExceptionRecord = {
        exceptionId: `exception-${fault.robotId}-${exceptionSeq}`,
        faultId: fault.faultId,
        robotId: fault.robotId,
        ...(taskId === undefined ? {} : { taskId }),
        type: fault.type,
        severity: classification.severity,
        message: fault.message,
        status: "open",
        openedAt: at,
        marksDegraded: classification.marksDegraded,
      };
      exception = saveException(exception);
      exceptionIdByFault.set(fault.faultId, exception.exceptionId);

      audit.append({
        at,
        actorType: "system",
        actorId: "fleet-health",
        action: "exception-opened",
        subjectType: "exception",
        subjectId: exception.exceptionId,
        detail: { faultId: fault.faultId, type: fault.type, severity: classification.severity },
      });

      if (taskId !== undefined && classification.holdsTask && holdTask(taskId)) {
        audit.append({
          at,
          actorType: "system",
          actorId: "fleet-health",
          action: "task-held",
          subjectType: "task",
          subjectId: taskId,
          detail: { exceptionId: exception.exceptionId, faultId: fault.faultId, status: "held" },
        });
        heldByException.set(exception.exceptionId, [
          ...(heldByException.get(exception.exceptionId) ?? []),
          taskId,
        ]);
      }

      if (classification.marksDegraded) {
        degraded.markDegraded(fault.robotId, fault);
        audit.append({
          at,
          actorType: "system",
          actorId: "fleet-health",
          action: "robot-degraded",
          subjectType: "robot",
          subjectId: fault.robotId,
          detail: {
            faultId: fault.faultId,
            reason: "COMMS_LOST — telemetry excluded from optimization",
          },
        });
      }

      return { classification, exception };
    },

    ingestTelemetry(sample: TelemetrySample): TelemetryIngestResult {
      const admitted = degraded.admitTelemetry(sample);
      const linkRestored = degraded.recordTelemetry(sample);
      if (!linkRestored) {
        return { admitted, linkRestored };
      }
      const at = now();
      audit.append({
        at,
        actorType: "system",
        actorId: "fleet-health",
        action: "telemetry-restored",
        subjectType: "robot",
        subjectId: sample.robotId,
        detail: { note: "fresh telemetry after COMMS_LOST — link proven back" },
      });
      // Auto-release the robot's open comms-loss exception (and its holds) —
      // the sample proves the link; no human touch is needed for this class.
      for (const record of exceptionById.values()) {
        if (
          record.robotId === sample.robotId &&
          record.status !== "released" &&
          policy.telemetryClearedFaults.has(record.type)
        ) {
          const released = saveException({
            ...record,
            status: "released",
            releasedAt: at,
            releasedReason: "fresh telemetry restored the link",
          });
          audit.append({
            at,
            actorType: "system",
            actorId: "fleet-health",
            action: "exception-released",
            subjectType: "exception",
            subjectId: released.exceptionId,
            detail: { reason: "fresh telemetry restored the link" },
          });
          releaseExceptionTasks(released.exceptionId, at);
        }
      }
      return { admitted, linkRestored };
    },

    recordDiagnosis(diagnosis: AgentDiagnosis): ExceptionRecord | null {
      const exceptionId = exceptionIdByFault.get(diagnosis.faultId);
      if (exceptionId === undefined) {
        return null; // no tracked fault for this diagnosis — typed absence, not an error
      }
      const existing = requireException(exceptionId);
      const at = now();
      const updated = saveException({
        ...existing,
        severity: existing.severity === diagnosis.severity ? existing.severity : diagnosis.severity,
        suggestedRecovery: diagnosis.suggestedRecovery.kind,
      });
      audit.append({
        at,
        actorType: "device-agent",
        actorId: `device-agent-${diagnosis.robotId}`,
        action: "agent-diagnosis",
        subjectType: "exception",
        subjectId: exceptionId,
        detail: {
          diagnosisId: diagnosis.diagnosisId,
          severity: diagnosis.severity,
          suggestedRecovery: diagnosis.suggestedRecovery.kind,
          selfClearing: String(diagnosis.selfClearing),
        },
      });
      return updated;
    },

    recordIntervention(input: InterventionInput): Intervention {
      const at = now();
      interventionSeq += 1;
      const candidate = {
        interventionId: `intervention-${input.robotId}-${interventionSeq}`,
        ts: at,
        robotId: input.robotId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        kind: input.kind,
        operatorId: input.operatorId,
        reason: input.reason,
        ...(input.planId === undefined ? {} : { planId: input.planId }),
      };
      const parsed = InterventionSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new FleetHealthError(
          "INTERVENTION_INVALID",
          `intervention for robot "${input.robotId}" failed the Intervention schema: ${parsed.error.message}`,
        );
      }
      interventions.push(parsed.data);
      audit.append({
        at,
        actorType: "operator",
        actorId: input.operatorId,
        action: `intervention-${input.kind}`,
        subjectType: "robot",
        subjectId: input.robotId,
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        detail: {
          interventionId: parsed.data.interventionId,
          kind: input.kind,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        },
      });
      return parsed.data;
    },

    assignTask(robotId: string, taskId: string): void {
      taskOfRobot.set(robotId, taskId);
      registerTask(taskId, robotId, "scheduled");
    },

    taskStatus(taskId: string): TaskStatus | null {
      return tasks.get(taskId)?.status ?? null;
    },

    heldTasks(): readonly string[] {
      return [...tasks.values()]
        .filter((task) => task.status === "held")
        .map((task) => task.taskId);
    },

    exceptions(): readonly ExceptionRecord[] {
      return [...exceptionById.values()];
    },

    openExceptions(): readonly ExceptionRecord[] {
      return [...exceptionById.values()].filter((record) => record.status !== "released");
    },

    exception(exceptionId: string): ExceptionRecord {
      return requireException(exceptionId);
    },

    acknowledgeException(exceptionId: string, operatorId: string): ExceptionRecord {
      const record = requireException(exceptionId);
      if (record.status !== "open") {
        throw new FleetHealthError(
          "EXCEPTION_INVALID_TRANSITION",
          `exception "${exceptionId}" cannot be acknowledged from status "${record.status}"`,
        );
      }
      const at = now();
      const updated = saveException({ ...record, status: "acknowledged", acknowledgedAt: at });
      audit.append({
        at,
        actorType: "operator",
        actorId: operatorId,
        action: "exception-acknowledged",
        subjectType: "exception",
        subjectId: exceptionId,
      });
      return updated;
    },

    releaseException(exceptionId: string, operatorId: string, reason: string): ExceptionRecord {
      const record = requireException(exceptionId);
      if (record.status === "released") {
        throw new FleetHealthError(
          "EXCEPTION_INVALID_TRANSITION",
          `exception "${exceptionId}" is already released`,
        );
      }
      const at = now();
      const updated = saveException({
        ...record,
        status: "released",
        releasedAt: at,
        releasedReason: reason,
      });
      audit.append({
        at,
        actorType: "operator",
        actorId: operatorId,
        action: "exception-released",
        subjectType: "exception",
        subjectId: exceptionId,
        detail: { reason },
      });
      releaseExceptionTasks(exceptionId, at);
      return updated;
    },

    interventions: () => [...interventions],
    healthOf: (robotId: string) => degraded.healthOf(robotId),
    degradedRobots: () => degraded.degradedRobots(),
    admitTelemetry: (sample: TelemetrySample) => degraded.admitTelemetry(sample),
  };
}
