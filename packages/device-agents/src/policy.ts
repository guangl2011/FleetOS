import type { ExternalConstraintPack, FaultEvent, Robot } from "@fleetos/core-schema";
import type { AssignedEnvelope } from "@fleetos/scheduler";
import type { DigitalShadowSlice } from "@fleetos/world-model";

import { diagnoseFault } from "./diagnosis.js";
import type { DiagnosisBody } from "./diagnosis.js";
import { shiftConflictsWithHardWindows } from "./replan.js";
import type { ReplanCandidate } from "./replan.js";

/**
 * The policy seam (spec agentic operations, D4 claim 6): a device agent
 * delegates all judgment to its policy object. The MVP ships
 * `deterministic-v1`; Phase I swaps LLM-based reasoner policies through this
 * same interface — a falsifiable swap measured against the same benchmark,
 * never a rewrite of consumers. The MVP policy proposes; the agent validates
 * against the envelope and audits — a policy is untrusted by construction,
 * including the bundled one.
 */
export const DETERMINISTIC_POLICY_ID = "deterministic-v1";

export interface AgentPolicy {
  /** Lineage id: "deterministic-v1" today; Phase I adds LLM reasoners. */
  readonly id: string;
  diagnose(input: DiagnosisInput): DiagnosisBody;
  /** Draft a local replan for the current ground truth, or null for nothing to propose. */
  proposeReplan(input: ReplanInput): ReplanCandidate | null;
}

export interface DiagnosisInput {
  readonly fault: FaultEvent;
  readonly robot: Robot;
  readonly envelope: AssignedEnvelope | null;
}

export interface ReplanInput {
  readonly robot: Robot;
  readonly slice: DigitalShadowSlice;
  readonly envelope: AssignedEnvelope;
  readonly packs: readonly ExternalConstraintPack[];
  /** Deterministic "now" (RFC 3339) — the injected clock's instant. */
  readonly now: string;
  readonly localOffsetMinutes: number;
}

/**
 * The deterministic generation trigger: a self-clearing WEATHER_HOLD on a
 * task that has not yet started proposes shifting the start later — wait out
 * the hold rather than drop the task. Candidates run from the tolerance edge
 * downward until one is hard-window-safe; none fits, no proposal. The
 * reviewer stays the authority; generation only drafts.
 */
function proposeWaitOutShift(input: ReplanInput): ReplanCandidate | null {
  if (input.slice.activeFault?.type !== "WEATHER_HOLD") {
    return null;
  }
  const { envelope } = input;
  const startMs = Date.parse(envelope.assignedStartAt);
  const durationMs = Date.parse(envelope.assignedEndAt) - startMs;
  if (!Number.isFinite(startMs) || durationMs <= 0) {
    return null;
  }
  if (Date.parse(input.now) > startMs) {
    return null; // Work has begun — a start shift is meaningless; recovery owns the fault.
  }
  for (let shiftMinutes = envelope.shiftToleranceMinutes; shiftMinutes >= 1; shiftMinutes -= 1) {
    const newStartMs = startMs + shiftMinutes * 60_000;
    if (
      !shiftConflictsWithHardWindows(
        newStartMs,
        durationMs,
        input.packs,
        envelope.siteId,
        input.slice.kind,
        input.localOffsetMinutes,
      )
    ) {
      return {
        kind: "shift-start",
        taskId: envelope.taskId,
        newStartAt: new Date(newStartMs).toISOString(),
        reason: `WEATHER_HOLD before start; shift within the envelope's ±${envelope.shiftToleranceMinutes} min tolerance to wait it out`,
      };
    }
  }
  return null;
}

/** The MVP policy: bounded diagnosis table plus the wait-out-a-weather-hold shift. */
export function createDeterministicPolicy(): AgentPolicy {
  return {
    id: DETERMINISTIC_POLICY_ID,
    diagnose: ({ fault, robot, envelope }) => diagnoseFault(fault, robot, envelope),
    proposeReplan: proposeWaitOutShift,
  };
}
