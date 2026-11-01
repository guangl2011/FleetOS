/**
 * Plan fixtures — PlanRowView shapes built on core-schema's exampleDispatchPlan
 * (schema-valid by construction) plus the scheduler-level charging/unassigned
 * extensions, so ScheduleBoard renders against the real contract.
 */
import type { SchedulingObjective } from "@fleetos/scheduler";
import type { PlanRowView } from "../api/types";

const exampleObjective: SchedulingObjective = {
  onTimeWeight: 100,
  batteryReserveFloorPct: 20,
  travelCostPerHour: 50,
  interventionCost: 500,
  energyCostWeight: 1,
};

/** A committed plan assigning one task to greenworks-1 with charge windows. */
export function currentPlanView(): PlanRowView {
  return {
    planId: "plan-risk-aware-2026-11-01T13:00:00.000Z",
    plannerTag: "risk-aware",
    status: "committed",
    createdAt: "2026-11-01T13:00:00.000Z",
    committedAt: "2026-11-01T13:02:00.000Z",
    plan: {
      plan: {
        schemaVersion: "1.0.0",
        planId: "plan-risk-aware-2026-11-01T13:00:00.000Z",
        createdAt: "2026-11-01T13:00:00.000Z",
        assignments: [
          {
            robotId: "greenworks-1",
            taskId: "task-1",
            startAt: "2026-11-01T14:00:00.000Z",
            estMinutes: 45,
            riskNotes: ["battery reserve projected 26% at completion"],
          },
          {
            robotId: "navimow-1",
            taskId: "task-2",
            startAt: "2026-11-01T16:00:00.000Z",
            estMinutes: 40,
            riskNotes: [],
          },
        ],
        projected: {
          onTimeCompletion: 0.9,
          expectedInterventions: 0.25,
          minBatteryReservePct: 26,
        },
      },
      charging: [
        {
          robotId: "navimow-1",
          startAt: "2026-11-01T15:00:00.000Z",
          estMinutes: 45,
          targetBatteryPct: 100,
          reason: "off-peak window per tariff pack curve-pse-2026q4",
        },
      ],
      unassigned: [],
    },
    objective: exampleObjective,
  };
}

/** A draft plan awaiting operator review — commit is disabled until this exists. */
export function draftPlanView(): PlanRowView {
  const committed = currentPlanView();
  return {
    ...committed,
    planId: "plan-baseline-2026-11-01T13:05:00.000Z",
    plannerTag: "baseline",
    status: "draft",
    createdAt: "2026-11-01T13:05:00.000Z",
    committedAt: null,
    plan: {
      ...committed.plan,
      plan: {
        ...committed.plan.plan,
        planId: "plan-baseline-2026-11-01T13:05:00.000Z",
        createdAt: "2026-11-01T13:05:00.000Z",
        projected: {
          onTimeCompletion: 0.72,
          expectedInterventions: 0.6,
          minBatteryReservePct: 18,
        },
      },
    },
  };
}
