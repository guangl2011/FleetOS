/**
 * Schedule board — the committed plan as a per-robot work list, plus the draft
 * plan panel (generate → review projections → commit). Pure props: planning
 * and commit happen through the callbacks the App wires to the API client.
 */
import { useState } from "react";

import type { ScheduleEntry } from "@fleetos/core-schema";

import { fmtClock, fmtPct } from "../format";
import type { PlanRowView, SiteView, TaskView } from "../api/types";
import { Badge, EmptyState, Panel } from "./ui";

export type SchedulerChoice = "risk-aware" | "baseline";

export interface RobotAssignments {
  readonly robotId: string;
  readonly entries: readonly ScheduleEntry[];
}

/** Groups a plan's assignments by robot, preserving start-time order. */
export function assignmentsByRobot(plan: PlanRowView): readonly RobotAssignments[] {
  const byRobot = new Map<string, ScheduleEntry[]>();
  for (const entry of plan.plan.plan.assignments) {
    const list = byRobot.get(entry.robotId);
    if (list === undefined) {
      byRobot.set(entry.robotId, [entry]);
    } else {
      list.push(entry);
    }
  }
  return [...byRobot.entries()].map(([robotId, entries]) => ({
    robotId,
    entries: [...entries].sort((a, b) => (a.startAt < b.startAt ? -1 : 1)),
  }));
}

export function siteLabel(sites: readonly SiteView[], siteId: string): string {
  const site = sites.find((candidate) => candidate.siteId === siteId);
  return site === undefined ? siteId : `${site.name} (${siteId})`;
}

function ProjectionChips(props: {
  readonly projections: PlanRowView["plan"]["plan"]["projected"];
}) {
  const projected = props.projections;
  return (
    <div className="chip-row">
      <span className="chip">
        Projected on-time: <strong>{fmtPct(projected.onTimeCompletion)}</strong>
      </span>
      <span className="chip">
        Expected interventions: <strong>{projected.expectedInterventions.toFixed(2)}</strong>
      </span>
      <span className="chip">
        Min battery reserve: <strong>{fmtPct(projected.minBatteryReservePct / 100)}</strong>
      </span>
    </div>
  );
}

export function ScheduleBoard(props: {
  readonly currentPlan: PlanRowView | null;
  readonly draftPlan: PlanRowView | null;
  readonly tasks: readonly TaskView[];
  readonly sites: readonly SiteView[];
  readonly busy: boolean;
  readonly onGenerate: (scheduler: SchedulerChoice) => void;
  readonly onCommit: () => void;
}) {
  const [scheduler, setScheduler] = useState<SchedulerChoice>("risk-aware");
  const committed = props.currentPlan;
  const draft = props.draftPlan;

  return (
    <Panel
      title="Schedule board"
      subtitle="The committed plan is what robots execute; drafts are review-only until committed"
      actions={
        <>
          <label className="inline-label" htmlFor="scheduler-choice">
            Scheduler
          </label>
          <select
            id="scheduler-choice"
            data-testid="scheduler-choice"
            value={scheduler}
            onChange={(event) => setScheduler(event.target.value as SchedulerChoice)}
          >
            <option value="risk-aware">risk-aware</option>
            <option value="baseline">rule-based baseline</option>
          </select>
          <button
            type="button"
            data-testid="generate-plan"
            disabled={props.busy}
            onClick={() => props.onGenerate(scheduler)}
          >
            Generate plan
          </button>
          <button
            type="button"
            data-testid="commit-plan"
            disabled={props.busy || draft === null}
            onClick={props.onCommit}
          >
            Commit plan
          </button>
        </>
      }
    >
      {draft !== null ? (
        <div className="draft-box" data-testid="draft-panel">
          <h3>
            Draft plan <span className="mono">{draft.planId}</span>{" "}
            <Badge tone="violet">{draft.plannerTag}</Badge>
          </h3>
          <p className="muted">
            {draft.plan.plan.assignments.length} assignment(s) · {draft.plan.charging.length} charge window(s) ·{" "}
            {draft.plan.unassigned.length} unassigned — review the projections, then commit.
          </p>
          <ProjectionChips projections={draft.plan.plan.projected} />
        </div>
      ) : null}

      {committed === null ? (
        <EmptyState message="No committed plan yet — generate one and commit it to dispatch the fleet." />
      ) : (
        <div data-testid="committed-plan">
          <div className="committed-summary">
            <h3>
              Committed plan <span className="mono">{committed.planId}</span>{" "}
              <Badge tone="green">committed</Badge>
            </h3>
            <ProjectionChips projections={committed.plan.plan.projected} />
          </div>

          {assignmentsByRobot(committed).map((group) => (
            <div key={group.robotId} className="robot-schedule" data-testid={`schedule-${group.robotId}`}>
              <h4 className="mono">{group.robotId}</h4>
              <ul className="assignment-list">
                {group.entries.map((entry) => {
                  const task = props.tasks.find((candidate) => candidate.taskId === entry.taskId);
                  return (
                    <li key={entry.taskId} className="assignment-row">
                      <span className="assignment-time">{fmtClock(entry.startAt)}</span>
                      <span className="mono">{entry.taskId}</span>
                      <span className="muted">
                        {task === undefined ? "site unknown" : siteLabel(props.sites, task.siteId)} ·{" "}
                        {entry.estMinutes} min
                      </span>
                      {entry.riskNotes.length > 0 ? (
                        <span className="risk-notes" title={entry.riskNotes.join(" | ")}>
                          <Badge tone="amber">{entry.riskNotes.length} risk note(s)</Badge>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {committed.plan.charging.length > 0 ? (
            <div className="charging-section">
              <h4>Charge windows</h4>
              <ul className="assignment-list">
                {committed.plan.charging.map((charge) => (
                  <li key={`${charge.robotId}-${charge.startAt}`} className="assignment-row">
                    <span className="assignment-time">{fmtClock(charge.startAt)}</span>
                    <span className="mono">{charge.robotId}</span>
                    <span className="muted">
                      {charge.estMinutes} min → {fmtPct(charge.targetBatteryPct / 100)} · {charge.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {committed.plan.unassigned.length > 0 ? (
            <div className="unassigned-section">
              <h4>Unassigned ({committed.plan.unassigned.length})</h4>
              <ul className="assignment-list">
                {committed.plan.unassigned.map((entry) => (
                  <li key={entry.taskId} className="assignment-row">
                    <span className="mono">{entry.taskId}</span>
                    <span className="muted">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
