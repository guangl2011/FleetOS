/**
 * Proposal review — the human gate on device-agent autonomy. Pending
 * proposals (bounded shift/swap moves the agent drafted) get approve/reject
 * with a recorded reason; operators can also ask an agent for a proposal.
 * Pure props — every decision is a callback wired by the App.
 */
import { useState } from "react";

import { fmtDateTime } from "../format";
import type { ProposalRowView, ReplanProposal } from "../api/types";
import { Badge, EmptyState, Panel } from "./ui";

export function proposalKindLabel(proposal: ReplanProposal): string {
  return proposal.kind === "shift-start"
    ? `shift start of ${proposal.taskId} → ${proposal.newStartAt}`
    : `swap ${proposal.taskIdA} ↔ ${proposal.taskIdB}`;
}

export function ProposalReview(props: {
  readonly proposals: readonly ProposalRowView[];
  readonly candidateRobots: readonly string[];
  readonly allRobotIds: readonly string[];
  readonly busy: boolean;
  readonly onRequest: (robotId: string) => void;
  readonly onApprove: (proposalId: string, reason: string) => void;
  readonly onReject: (proposalId: string, reason: string) => void;
}) {
  const [requestRobot, setRequestRobot] = useState("");
  const pending = props.proposals.filter((row) => row.status === "pending");
  const decided = props.proposals.filter((row) => row.status !== "pending");

  const selectOptions = props.candidateRobots.length > 0 ? props.candidateRobots : props.allRobotIds;
  const selected = requestRobot === "" ? (selectOptions[0] ?? "") : requestRobot;

  return (
    <Panel
      title="Device-agent proposals"
      subtitle="One agent per device proposes bounded local replans; nothing moves without a human decision"
      actions={
        <>
          <label className="inline-label" htmlFor="request-robot">
            Request proposal from
          </label>
          <select
            id="request-robot"
            data-testid="request-robot"
            value={selected}
            onChange={(event) => setRequestRobot(event.target.value)}
          >
            {selectOptions.length === 0 ? <option value="">no robots</option> : null}
            {selectOptions.map((robotId) => (
              <option key={robotId} value={robotId}>
                {robotId}
                {props.candidateRobots.includes(robotId) ? " (weather hold)" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="request-proposal"
            disabled={props.busy || selected === ""}
            onClick={() => props.onRequest(selected)}
          >
            Request proposal
          </button>
        </>
      }
    >
      <p className="muted">
        The deterministic agent policy proposes only when it finds a bounded move — e.g. waiting out a
        WEATHER_HOLD by shifting its task start within the envelope's tolerance. The planner marks those
        robots "(weather hold)" above.
      </p>

      {pending.length === 0 ? (
        <EmptyState message="No pending proposals." />
      ) : (
        pending.map((row) => (
          <PendingProposalCard
            key={row.proposalId}
            row={row}
            busy={props.busy}
            onApprove={props.onApprove}
            onReject={props.onReject}
          />
        ))
      )}

      {decided.length > 0 ? (
        <details className="released-history">
          <summary>Decided proposals ({decided.length})</summary>
          <ul className="assignment-list">
            {decided.map((row) => (
              <li key={row.proposalId} className="assignment-row">
                <span className="mono">{row.proposalId}</span>
                <Badge tone={row.status === "approved" ? "green" : "gray"}>{row.status}</Badge>
                <span className="mono">{row.robotId}</span>
                <span className="muted">
                  {proposalKindLabel(row.proposal)} · {row.decisionReason ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

function PendingProposalCard(props: {
  readonly row: ProposalRowView;
  readonly busy: boolean;
  readonly onApprove: (proposalId: string, reason: string) => void;
  readonly onReject: (proposalId: string, reason: string) => void;
}) {
  const row = props.row;
  const [reason, setReason] = useState(row.status === "pending" ? "approved from console" : "");

  return (
    <article className="exception-card proposal-card" data-testid={`proposal-${row.proposalId}`}>
      <header className="exception-header">
        <Badge tone="violet">{row.proposal.kind}</Badge>
        <span className="mono">{row.robotId}</span>
        <Badge tone={row.review.accepted ? "green" : "red"}>
          {row.review.accepted ? "in envelope" : `review: ${row.review.code}`}
        </Badge>
      </header>
      <p className="exception-message">{proposalKindLabel(row.proposal)}</p>
      <p className="muted exception-meta">
        {row.proposal.reason} · proposed {fmtDateTime(row.createdAt)} · envelope{" "}
        <span className="mono">{row.proposal.envelopeId}</span>
      </p>
      <div className="exception-actions">
        <label className="inline-label" htmlFor={`proposal-reason-${row.proposalId}`}>
          Decision reason
        </label>
        <input
          id={`proposal-reason-${row.proposalId}`}
          data-testid={`proposal-reason-${row.proposalId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={props.busy}
        />
        <button
          type="button"
          className="button-approve"
          data-testid={`approve-proposal-${row.proposalId}`}
          disabled={props.busy}
          onClick={() => props.onApprove(row.proposalId, reason)}
        >
          Approve
        </button>
        <button
          type="button"
          className="button-reject"
          data-testid={`reject-proposal-${row.proposalId}`}
          disabled={props.busy}
          onClick={() => props.onReject(row.proposalId, reason)}
        >
          Reject
        </button>
      </div>
    </article>
  );
}
