/**
 * App — the operator console's wiring layer. Components stay presentational;
 * this module owns API calls, polling, and action state (the spec's
 * "presentational first, then API wiring" split).
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePolling } from "./api/hooks";
import { ApiClientError, api } from "./api/client";
import type {
  BenchmarkReportView,
  ExceptionRecord,
  HealthSummaryView,
  PlanRowView,
  ProposalRowView,
  RobotView,
  SiteView,
  TaskView,
} from "./api/types";
import { BenchmarkView } from "./components/BenchmarkView";
import { CompliancePanel } from "./components/CompliancePanel";
import { ExceptionQueue, type RecoveryDecision } from "./components/ExceptionQueue";
import { FleetList } from "./components/FleetList";
import { FleetMap } from "./components/FleetMap";
import { ProposalReview } from "./components/ProposalReview";
import { ScheduleBoard, type SchedulerChoice } from "./components/ScheduleBoard";
import { Badge } from "./components/ui";
import type { Tone } from "./format";

const POLL_INTERVAL_MS = 5_000;

type Connection = "connecting" | "ok" | "unreachable";

const connectionTone: Record<Connection, Tone> = {
  connecting: "amber",
  ok: "green",
  unreachable: "red",
};

export default function App() {
  const [operatorId, setOperatorId] = useState("console-operator");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [health, setHealth] = useState<HealthSummaryView | null>(null);
  const [robots, setRobots] = useState<readonly RobotView[]>([]);
  const [sites, setSites] = useState<readonly SiteView[]>([]);
  const [tasks, setTasks] = useState<readonly TaskView[]>([]);
  const [currentPlan, setCurrentPlan] = useState<PlanRowView | null>(null);
  const [draftPlan, setDraftPlan] = useState<PlanRowView | null>(null);
  const [exceptions, setExceptions] = useState<readonly ExceptionRecord[]>([]);
  const [proposals, setProposals] = useState<readonly ProposalRowView[]>([]);
  const [runs, setRuns] = useState<readonly BenchmarkReportView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [robotRows, siteRows, taskRows, exceptionRows, proposalRows, runRows, healthSummary] =
        await Promise.all([
          api.robots(),
          api.sites(),
          api.tasks(),
          api.exceptions(),
          api.proposals(),
          api.benchmarkRuns(),
          api.health(),
        ]);
      setRobots(robotRows.robots);
      setSites(siteRows.sites);
      setTasks(taskRows.tasks);
      setExceptions(exceptionRows.exceptions);
      setProposals(proposalRows.proposals);
      setRuns(runRows.runs);
      setHealth(healthSummary);
      try {
        setCurrentPlan((await api.committedPlan()).plan);
      } catch (planError) {
        if (planError instanceof ApiClientError && planError.code === "NO_COMMITTED_PLAN") {
          setCurrentPlan(null);
        } else {
          throw planError;
        }
      }
      setConnection("ok");
    } catch {
      setConnection("unreachable");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(POLL_INTERVAL_MS, refresh, busy);

  /** One wrapper for every operator action: busy gate, toasts, refetch. */
  const runAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setNotice(label);
      await refresh();
    } catch (actionError) {
      setError(
        actionError instanceof ApiClientError
          ? `${actionError.code}: ${actionError.message}`
          : String(actionError),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const onGenerate = useCallback(
    (scheduler: SchedulerChoice) => {
      void runAction(`Generated ${scheduler} plan`, async () => {
        const { plan } = await api.generatePlan(operatorId, scheduler);
        setDraftPlan(plan);
        return `Draft plan ${plan.planId} ready — review, then commit`;
      });
    },
    [operatorId, runAction],
  );

  const onCommit = useCallback(() => {
    if (draftPlan === null) {
      return;
    }
    const planId = draftPlan.planId;
    void runAction(`Committed plan ${planId}`, async () => {
      await api.commitPlan(operatorId, planId);
      setDraftPlan(null);
      return `Plan ${planId} committed — assignments are live`;
    });
  }, [draftPlan, operatorId, runAction]);

  const onAcknowledge = useCallback(
    (exceptionId: string) => {
      void runAction(`Acknowledged exception ${exceptionId}`, async () => {
        await api.acknowledgeException(operatorId, exceptionId);
        return `Exception ${exceptionId} acknowledged`;
      });
    },
    [operatorId, runAction],
  );

  const onRelease = useCallback(
    (exceptionId: string, reason: string) => {
      void runAction(`Released exception ${exceptionId}`, async () => {
        await api.releaseException(operatorId, exceptionId, reason);
        return `Exception ${exceptionId} released — held tasks are schedulable again`;
      });
    },
    [operatorId, runAction],
  );

  const onRecovery = useCallback(
    (exceptionId: string, decision: RecoveryDecision, reason: string) => {
      void runAction(`Recovery ${decision} for ${exceptionId}`, async () => {
        const outcome = await api.decideRecovery(operatorId, exceptionId, decision, reason);
        return `Recovery ${decision} — ${outcome.decision === "approve" ? "executed through the audited command path" : "no command sent"}`;
      });
    },
    [operatorId, runAction],
  );

  const onRequestProposal = useCallback(
    (robotId: string) => {
      void runAction(`Requested agent proposal for ${robotId}`, async () => {
        const result = await api.requestProposal(operatorId, robotId);
        return result === undefined
          ? `${robotId}'s agent proposed nothing — no move inside its envelope`
          : `${robotId}'s agent proposed a bounded replan — review below`;
      });
    },
    [operatorId, runAction],
  );

  const onApproveProposal = useCallback(
    (proposalId: string, reason: string) => {
      void runAction(`Approved proposal ${proposalId}`, async () => {
        await api.approveProposal(operatorId, proposalId, reason);
        return `Proposal ${proposalId} approved — recovery executed through the audited command path`;
      });
    },
    [operatorId, runAction],
  );

  const onRejectProposal = useCallback(
    (proposalId: string, reason: string) => {
      void runAction(`Rejected proposal ${proposalId}`, async () => {
        await api.rejectProposal(operatorId, proposalId, reason);
        return `Proposal ${proposalId} rejected — the scheduler keeps the committed plan`;
      });
    },
    [operatorId, runAction],
  );

  // The device agent proposes only inside its envelope; a WEATHER_HOLD fault is
  // the demo's canonical proposal trigger, so the selector surfaces those first.
  const allRobotIds = useMemo(() => robots.map((view) => view.robot.robotId), [robots]);
  const proposalCandidates = useMemo(
    () =>
      robots
        .filter((view) => view.shadow?.activeFault?.type === "WEATHER_HOLD")
        .map((view) => view.robot.robotId),
    [robots],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>FleetOS</h1>
          <span className="app-subtitle">
            Vendor-independent fleet operations · Circunar Inc.
          </span>
        </div>
        <div className="header-status">
          <label className="operator-label">
            operator
            <input
              value={operatorId}
              onChange={(event) => setOperatorId(event.target.value)}
              aria-label="operator id"
              data-testid="operator-id"
            />
          </label>
          <Badge tone={connectionTone[connection]}>api {connection}</Badge>
          {health !== null && (
            <Badge tone={health.degraded > 0 ? "amber" : "green"}>
              {health.healthy} healthy · {health.degraded} degraded · {health.openExceptions} open
            </Badge>
          )}
        </div>
      </header>

      {error !== null && (
        <div className="banner banner-error" role="alert" data-testid="error-banner">
          {error}
          <button type="button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      {notice !== null && (
        <div className="banner banner-ok" data-testid="notice-banner">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="console-grid">
        <FleetMap sites={sites} robots={robots} />
        <FleetList robots={robots} />
        <ScheduleBoard
          currentPlan={currentPlan}
          draftPlan={draftPlan}
          tasks={tasks}
          sites={sites}
          busy={busy}
          onGenerate={onGenerate}
          onCommit={onCommit}
        />
        <ExceptionQueue
          exceptions={exceptions}
          busy={busy}
          onAcknowledge={onAcknowledge}
          onRelease={onRelease}
          onRecovery={onRecovery}
        />
        <ProposalReview
          proposals={proposals}
          candidateRobots={proposalCandidates}
          allRobotIds={allRobotIds}
          busy={busy}
          onRequest={onRequestProposal}
          onApprove={onApproveProposal}
          onReject={onRejectProposal}
        />
        <BenchmarkView runs={runs} />
        <CompliancePanel robots={robots} />
      </main>
    </div>
  );
}
