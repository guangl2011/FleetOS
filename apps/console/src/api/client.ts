/**
 * Typed fetch client for the FleetOS API. Paths mirror apps/api/src/routes.ts;
 * the dev server proxies /api → 127.0.0.1:8737 and strips the prefix, so the
 * browser sees one same-origin deployment (see vite.config.ts).
 */
import type {
  BenchmarkReportView,
  ExceptionRecord,
  HealthSummaryView,
  PlanRowView,
  ProposalRowView,
  RecoveryDecisionView,
  RobotView,
  SiteView,
  TaskView,
} from "./types";

const API_BASE: string = import.meta.env.VITE_FLEETOS_API_BASE ?? "/api";

/** The API's error envelope: { error: { code, message, details? } }. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  readonly method?: "POST" | "PATCH";
  readonly body?: unknown;
  /** Sent as x-operator-id — mutating routes reject requests without it. */
  readonly operatorId?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.operatorId === undefined ? {} : { "x-operator-id": options.operatorId }),
    },
    // exactOptionalPropertyTypes: fetch's body rejects an explicit undefined.
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    let message = response.statusText;
    try {
      const data: unknown = await response.json();
      if (isErrorEnvelope(data)) {
        code = data.error.code;
        message = data.error.message;
      }
    } catch {
      // Body was not JSON — keep the status-text fallback.
    }
    throw new ApiClientError(message, response.status, code);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function isErrorEnvelope(value: unknown): value is { error: { code: string; message: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object"
  );
}

export interface SchedulerRequest {
  readonly scheduler?: "risk-aware" | "baseline";
}

export const api = {
  // Reads
  robots: () => request<{ robots: RobotView[] }>("/fleet/robots"),
  sites: () => request<{ sites: SiteView[] }>("/fleet/sites"),
  health: () => request<HealthSummaryView>("/fleet/health"),
  tasks: () => request<{ tasks: TaskView[] }>("/tasks"),
  committedPlan: () => request<{ plan: PlanRowView }>("/schedule/plans/current"),
  exceptions: () => request<{ exceptions: ExceptionRecord[] }>("/exceptions"),
  proposals: () => request<{ proposals: ProposalRowView[] }>("/agent-proposals"),
  benchmarkRuns: () => request<{ runs: BenchmarkReportView[] }>("/benchmarks/runs"),

  // Schedule
  generatePlan: (operatorId: string, scheduler: SchedulerRequest["scheduler"]) =>
    request<{ plan: PlanRowView }>("/schedule/plan", {
      method: "POST",
      operatorId,
      body: { ...(scheduler === undefined ? {} : { scheduler }) },
    }),
  commitPlan: (operatorId: string, planId: string) =>
    request<{ plan: PlanRowView }>(`/schedule/plans/${planId}/commit`, { method: "POST", operatorId }),

  // Exceptions & interventions
  acknowledgeException: (operatorId: string, exceptionId: string) =>
    request<{ exception: ExceptionRecord }>(`/exceptions/${exceptionId}/acknowledge`, {
      method: "POST",
      operatorId,
    }),
  releaseException: (operatorId: string, exceptionId: string, reason: string) =>
    request<{ exception: ExceptionRecord }>(`/exceptions/${exceptionId}/release`, {
      method: "POST",
      operatorId,
      body: { reason },
    }),
  decideRecovery: (operatorId: string, exceptionId: string, decision: "approve" | "reject", reason: string) =>
    request<RecoveryDecisionView>(`/exceptions/${exceptionId}/recovery`, {
      method: "POST",
      operatorId,
      body: { decision, reason },
    }),

  // Agent proposals
  requestProposal: (operatorId: string, robotId: string) =>
    request<unknown>("/agent-proposals/generate", { method: "POST", operatorId, body: { robotId } }),
  approveProposal: (operatorId: string, proposalId: string, reason: string) =>
    request<unknown>(`/agent-proposals/${proposalId}/approve`, {
      method: "POST",
      operatorId,
      body: { reason },
    }),
  rejectProposal: (operatorId: string, proposalId: string, reason: string) =>
    request<{ proposal: ProposalRowView }>(`/agent-proposals/${proposalId}/reject`, {
      method: "POST",
      operatorId,
      body: { reason },
    }),
};
