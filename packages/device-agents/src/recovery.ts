import type { CommandPermission } from "@fleetos/core-schema";

import type { RecoveryKind } from "./diagnosis.js";

/**
 * The human-approved recovery path (spec agentic operations): a diagnosis
 * suggests; a recorded operator decision approves or rejects; only then may
 * a recovery command exist at all. `issueRecoveryCommand` (agent.ts) is the
 * only place a `RecoveryCommand` is constructed — the dispatch layer may
 * send what it returns and nothing else, so "no recovery command executes
 * without human approval" holds structurally, not by convention.
 */

/** One recorded human decision on a diagnosis's suggested recovery. */
export interface RecoveryDecision {
  readonly decisionId: string;
  readonly diagnosisId: string;
  readonly robotId: string;
  readonly operatorId: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly at: string;
}

/** What the operator records — the agent stamps `decisionId` and `at`. */
export interface RecoveryDecisionInput {
  readonly diagnosisId: string;
  readonly operatorId: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
}

/**
 * The audited recovery command: bounded to the dispatch surface (resume /
 * dock-charge map to the capability allow-list's RESUME / DOCK_CHARGE).
 * There is no drive-to, no teleoperation, no safety-control field — robot
 * -local safety stays authoritative (spec non-goal guardrail).
 */
export interface RecoveryCommand {
  readonly commandId: string;
  readonly robotId: string;
  readonly diagnosisId: string;
  readonly decisionId: string;
  readonly kind: RecoveryKind;
  readonly permission: CommandPermission;
  readonly issuedAt: string;
}

/**
 * A resolved recovery: either a command-backed action (the human approved a
 * remote command) or a non-command action (dispatch a human, or the
 * scheduler reassigns the task — both outside the robot command surface).
 */
export type RecoveryResolution =
  | { readonly kind: "command"; readonly command: RecoveryCommand }
  | { readonly kind: "no-command"; readonly reason: "human-dispatch" | "scheduler-reassign" };

/**
 * Command-backed recoveries only. `reassign` and `human-service` are
 * approved actions too — they just never produce a robot command.
 */
export function commandableRecovery(kind: RecoveryKind): CommandPermission | null {
  switch (kind) {
    case "resume":
      return "RESUME";
    case "dock-charge":
      return "DOCK_CHARGE";
    case "reassign":
    case "human-service":
      return null;
  }
}
