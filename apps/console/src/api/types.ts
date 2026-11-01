/**
 * API view types — the console's contract with apps/api. Shared domain types
 * are imported from the packages that own them (type-only imports: the browser
 * bundle carries none of this code), and API row shapes are named locally
 * where the API defines them (store rows, benchmark reports, summaries).
 */
import type { CommandTicket } from "@fleetos/adapters-sdk";
import type { DispatchPlan, FleetTask, Intervention, Robot } from "@fleetos/core-schema";
import type { ReplanProposal, ReplanReview } from "@fleetos/device-agents";
import type { ExceptionRecord } from "@fleetos/fleet-health";
import type { SchedulerPlan, SchedulingObjective } from "@fleetos/scheduler";
import type { DigitalShadowSlice } from "@fleetos/world-model";

export type { CommandTicket, DispatchPlan, ExceptionRecord, Intervention, ReplanProposal, ReplanReview, Robot };

/** GET /fleet/robots — one robot's operator view (apps/api runtime.ts RobotView). */
export interface RobotView {
  readonly robot: Robot;
  readonly shadow: DigitalShadowSlice | null;
  readonly confidence: number;
  readonly health: string;
}

/** GET /fleet/health */
export interface HealthSummaryView {
  readonly healthy: number;
  readonly degraded: number;
  readonly unknown: number;
  readonly degradedRobots: readonly string[];
  readonly openExceptions: number;
}

/** GET /fleet/sites */
export interface SiteView {
  readonly siteId: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/** GET /tasks — task rows with the engine's HELD flag attached (list endpoint only). */
export interface TaskView {
  readonly taskId: string;
  readonly siteId: string;
  readonly status: string;
  readonly priority: number;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly estMinutes: number;
  readonly record: FleetTask;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly held?: boolean;
}

/** DispatchPlan.projected (core-schema PlanProjections). */
export interface PlanProjectionsView {
  readonly onTimeCompletion: number;
  readonly expectedInterventions: number;
  readonly minBatteryReservePct: number;
}

/** Plan rows as the API returns them (apps/api store/sqlite.ts PlanRow). */
export interface PlanRowView {
  readonly planId: string;
  readonly plannerTag: string;
  readonly status: "draft" | "committed" | "superseded";
  readonly createdAt: string;
  readonly committedAt: string | null;
  readonly plan: SchedulerPlan;
  readonly objective: SchedulingObjective;
}

/** GET /schedule/plans — summary projection of a plan row. */
export interface PlanSummaryView {
  readonly planId: string;
  readonly plannerTag: string;
  readonly status: string;
  readonly createdAt: string;
  readonly committedAt: string | null;
  readonly assignments: number;
  readonly charging: number;
  readonly unassigned: number;
  readonly projected: PlanProjectionsView;
}

/** GET /agent-proposals — proposal rows (apps/api store/sqlite.ts ProposalRow). */
export interface ProposalRowView {
  readonly proposalId: string;
  readonly robotId: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly proposal: ReplanProposal;
  readonly review: ReplanReview;
}

/** The scheduler-metric fields the benchmark view displays (per-scheduler run). */
export interface RunMetricsView {
  readonly onTimeCompletion: number;
  readonly interventionsPer100RobotHours: number;
  readonly energyCostUsd: number;
}

/** Benchmark run report (apps/api routes.ts compareSchedulers output). */
export interface BenchmarkReportView {
  readonly runId: string;
  readonly createdAt: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly baseline: RunMetricsView;
  readonly riskAware: RunMetricsView;
  readonly deltas: {
    readonly onTimeCompletionDeltaPp: number;
    readonly interventionReductionPct: number | null;
    readonly energyCostDeltaUsd: number;
  };
}

/** POST /exceptions/:id/recovery response (apps/api runtime.ts RecoveryDecisionOutcome). */
export interface RecoveryDecisionView {
  readonly decision: "approve" | "reject";
  readonly resolution: { readonly kind: string } | null;
  readonly intervention: Intervention;
  readonly ticket: CommandTicket | null;
}
