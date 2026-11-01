import type { DispatchPlan } from "@fleetos/core-schema";

import { SchedulerError } from "./errors.js";
import type { SchedulableTask } from "./input.js";
import type { SchedulerPlan } from "./plan.js";

/**
 * The scheduling core's contract with device agents (spec §Agentic
 * operations): the envelope is the boundary of a device agent's bounded
 * autonomy — the slice of the plan one robot owns. The agent may propose
 * local replans strictly inside it (order swaps among its own tasks,
 * start-time shifts within tolerance) and never outside; the scheduler
 * stays the global coordinator. An envelope is built per robot from the
 * committed plan; recovery commands stay human-gated regardless.
 */

/** Start-time shift an agent may propose in either direction (minutes). */
export const ENVELOPE_SHIFT_TOLERANCE_MINUTES = 10;

export interface AssignedEnvelope {
  readonly envelopeId: string;
  readonly robotId: string;
  /** The task the plan assigned first to this robot (the agent's current work). */
  readonly taskId: string;
  readonly siteId: string;
  /** Assigned work start (RFC 3339). */
  readonly assignedStartAt: string;
  /** Projected completion (RFC 3339) — startAt + estMinutes. */
  readonly assignedEndAt: string;
  /** The battery reserve floor in force when this envelope was issued. */
  readonly minBatteryReservePct: number;
  /** Other task ids assigned to this robot — the legal swap set. */
  readonly swappableTaskIds: readonly string[];
  /** Minutes of start-time shift the agent may propose in either direction. */
  readonly shiftToleranceMinutes: number;
}

/**
 * Derives one envelope per robot from a plan: the robot's first assignment
 * is its current task; remaining assignments (sorted by startAt, then
 * taskId) are the swap set. Task records supply each task's site (the plan
 * entry carries ids only). Plans with no assignments yield no envelopes.
 */
export function envelopesFromPlan(
  plan: SchedulerPlan,
  objective: { readonly batteryReserveFloorPct: number },
  tasks: readonly SchedulableTask[],
): readonly AssignedEnvelope[] {
  const siteByTask = new Map<string, string>();
  for (const task of tasks) {
    siteByTask.set(task.taskId, task.siteId);
  }
  const byRobot = new Map<string, DispatchPlan["assignments"]>();
  for (const entry of [...plan.plan.assignments].sort((a, b) =>
    a.startAt === b.startAt ? (a.taskId < b.taskId ? -1 : 1) : a.startAt < b.startAt ? -1 : 1,
  )) {
    const existing = byRobot.get(entry.robotId);
    if (existing === undefined) {
      byRobot.set(entry.robotId, [entry]);
    } else {
      existing.push(entry);
    }
  }
  const envelopes: AssignedEnvelope[] = [];
  for (const [robotId, entries] of byRobot) {
    const first = entries[0];
    if (first === undefined) {
      continue; // Unreachable: map keys exist only when at least one entry was added.
    }
    const startMs = Date.parse(first.startAt);
    const est = first.estMinutes;
    if (!Number.isFinite(startMs) || est <= 0) {
      throw new SchedulerError(
        "ENVELOPE_BUILD_FAILED",
        `assignment ${first.taskId} has invalid startAt/estMinutes`,
      );
    }
    const siteId = siteByTask.get(first.taskId);
    if (siteId === undefined) {
      throw new SchedulerError(
        "ENVELOPE_BUILD_FAILED",
        `assignment ${first.taskId} has no matching task record`,
      );
    }
    envelopes.push({
      envelopeId: `env-${robotId}-${first.taskId}`,
      robotId,
      taskId: first.taskId,
      siteId,
      assignedStartAt: first.startAt,
      assignedEndAt: new Date(startMs + est * 60_000).toISOString(),
      minBatteryReservePct: objective.batteryReserveFloorPct,
      swappableTaskIds: entries.slice(1).map((entry) => entry.taskId),
      shiftToleranceMinutes: ENVELOPE_SHIFT_TOLERANCE_MINUTES,
    });
  }
  return envelopes.sort((a, b) => (a.robotId < b.robotId ? -1 : a.robotId > b.robotId ? 1 : 0));
}
