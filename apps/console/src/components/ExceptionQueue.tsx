/**
 * Exception queue — faults surfaced for human triage. Intervention actions
 * (acknowledge, release, recovery approve/reject) are callbacks; the component
 * itself never calls the API. The recovery decision is the agentic loop's
 * human gate: the device agent diagnosed and proposed, the operator decides.
 */
import { useState } from "react";

import type { ExceptionRecord } from "@fleetos/fleet-health";

import { fmtDateTime, severityTone } from "../format";
import { Badge, EmptyState, Panel } from "./ui";

export type RecoveryDecision = "approve" | "reject";

export function ExceptionQueue(props: {
  readonly exceptions: readonly ExceptionRecord[];
  readonly busy: boolean;
  readonly onAcknowledge: (exceptionId: string) => void;
  readonly onRelease: (exceptionId: string, reason: string) => void;
  readonly onRecovery: (exceptionId: string, decision: RecoveryDecision, reason: string) => void;
}) {
  const open = props.exceptions.filter((exception) => exception.status !== "released");
  const released = props.exceptions.filter((exception) => exception.status === "released");

  return (
    <Panel
      title="Exception queue"
      subtitle="One exception per classified fault — acknowledge, decide the agent's suggested recovery, release"
    >
      {open.length === 0 ? (
        <EmptyState
          message={
            props.exceptions.length === 0
              ? "No exceptions — the fleet is quiet."
              : "No open exceptions — all handled."
          }
        />
      ) : (
        open.map((exception) => (
          <ExceptionCard
            key={exception.exceptionId}
            exception={exception}
            busy={props.busy}
            onAcknowledge={props.onAcknowledge}
            onRelease={props.onRelease}
            onRecovery={props.onRecovery}
          />
        ))
      )}

      {released.length > 0 ? (
        <details className="released-history">
          <summary>Released exceptions ({released.length})</summary>
          <ul className="assignment-list">
            {released.map((exception) => (
              <li key={exception.exceptionId} className="assignment-row">
                <span className="mono">{exception.exceptionId}</span>
                <Badge tone="gray">{exception.type}</Badge>
                <span className="mono">{exception.robotId}</span>
                <span className="muted">{exception.releasedReason ?? ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

function ExceptionCard(props: {
  readonly exception: ExceptionRecord;
  readonly busy: boolean;
  readonly onAcknowledge: (exceptionId: string) => void;
  readonly onRelease: (exceptionId: string, reason: string) => void;
  readonly onRecovery: (exceptionId: string, decision: RecoveryDecision, reason: string) => void;
}) {
  const exception = props.exception;
  const [reason, setReason] = useState("handled from console");

  return (
    <article
      className={`exception-card exception-${exception.severity}`}
      data-testid={`exception-${exception.exceptionId}`}
    >
      <header className="exception-header">
        <Badge tone={severityTone(exception.severity)}>{exception.severity}</Badge>
        <strong>{exception.type}</strong>
        <span className="mono">{exception.robotId}</span>
        <Badge tone={exception.status === "open" ? "red" : "amber"}>{exception.status}</Badge>
        {exception.marksDegraded ? <Badge tone="red">degraded mode</Badge> : null}
      </header>
      <p className="exception-message">{exception.message}</p>
      <p className="muted exception-meta">
        opened {fmtDateTime(exception.openedAt)}
        {exception.taskId === undefined ? "" : ` · task ${exception.taskId}`}
        {exception.suggestedRecovery === undefined
          ? ""
          : ` · agent suggests: ${exception.suggestedRecovery}`}
      </p>
      <div className="exception-actions">
        <label className="inline-label" htmlFor={`reason-${exception.exceptionId}`}>
          Reason
        </label>
        <input
          id={`reason-${exception.exceptionId}`}
          data-testid={`reason-${exception.exceptionId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={props.busy}
        />
        {exception.status === "open" ? (
          <button
            type="button"
            data-testid={`ack-${exception.exceptionId}`}
            disabled={props.busy}
            onClick={() => props.onAcknowledge(exception.exceptionId)}
          >
            Acknowledge
          </button>
        ) : null}
        {exception.suggestedRecovery !== undefined ? (
          <>
            <button
              type="button"
              className="button-approve"
              data-testid={`approve-recovery-${exception.exceptionId}`}
              disabled={props.busy}
              onClick={() => props.onRecovery(exception.exceptionId, "approve", reason)}
            >
              Approve recovery
            </button>
            <button
              type="button"
              className="button-reject"
              data-testid={`reject-recovery-${exception.exceptionId}`}
              disabled={props.busy}
              onClick={() => props.onRecovery(exception.exceptionId, "reject", reason)}
            >
              Reject recovery
            </button>
          </>
        ) : null}
        <button
          type="button"
          data-testid={`release-${exception.exceptionId}`}
          disabled={props.busy}
          onClick={() => props.onRelease(exception.exceptionId, reason)}
        >
          Release
        </button>
      </div>
    </article>
  );
}
