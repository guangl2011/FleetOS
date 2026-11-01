// @vitest-environment jsdom
import "../test/setup";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type { ProposalRowView } from "../api/types";

import { ProposalReview, proposalKindLabel } from "./ProposalReview";

const shiftProposal: ProposalRowView = {
  proposalId: "prop-1",
  robotId: "husqvarna-1",
  status: "pending",
  createdAt: "2026-11-01T14:05:00.000Z",
  decidedAt: null,
  decisionReason: null,
  proposal: {
    kind: "shift-start",
    proposalId: "prop-1",
    robotId: "husqvarna-1",
    envelopeId: "env-husqvarna-1",
    createdAt: "2026-11-01T14:05:00.000Z",
    taskId: "task-7",
    newStartAt: "2026-11-01T15:00:00.000Z",
    reason: "WEATHER_HOLD clear in 55 min; shift start inside tolerance",
  },
  review: { accepted: true, proposalId: "prop-1" },
};

const swapProposal: ProposalRowView = {
  proposalId: "prop-2",
  robotId: "navimow-1",
  status: "rejected",
  createdAt: "2026-11-01T12:00:00.000Z",
  decidedAt: "2026-11-01T12:01:00.000Z",
  decisionReason: "operator on site",
  proposal: {
    kind: "swap-tasks",
    proposalId: "prop-2",
    robotId: "navimow-1",
    envelopeId: "env-navimow-1",
    createdAt: "2026-11-01T12:00:00.000Z",
    taskIdA: "task-2",
    taskIdB: "task-3",
    reason: "travel-order swap saves 12 min",
  },
  review: { accepted: true, proposalId: "prop-2" },
};

describe("proposalKindLabel", () => {
  it("describes shift and swap moves in operator language", () => {
    expect(proposalKindLabel(shiftProposal.proposal)).toBe(
      "shift start of task-7 → 2026-11-01T15:00:00.000Z",
    );
    expect(proposalKindLabel(swapProposal.proposal)).toBe("swap task-2 ↔ task-3");
  });
});

describe("ProposalReview", () => {
  it("renders pending proposals with envelope badges and decision inputs", () => {
    render(
      <ProposalReview
        proposals={[shiftProposal]}
        candidateRobots={["husqvarna-1"]}
        allRobotIds={["husqvarna-1", "navimow-1"]}
        busy={false}
        onRequest={() => {}}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByTestId("proposal-prop-1")).toBeInTheDocument();
    expect(screen.getByText(/shift start of task-7/)).toBeInTheDocument();
    expect(screen.getByText("in envelope")).toBeInTheDocument();
    expect(screen.getByTestId("approve-proposal-prop-1")).toBeInTheDocument();
    expect(screen.getByTestId("reject-proposal-prop-1")).toBeInTheDocument();
  });

  it("emits approve/reject with the typed decision reason", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ProposalReview
        proposals={[shiftProposal]}
        candidateRobots={["husqvarna-1"]}
        allRobotIds={["husqvarna-1"]}
        busy={false}
        onRequest={() => {}}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await userEvent.type(screen.getByTestId("proposal-reason-prop-1"), " rain clearing");
    await userEvent.click(screen.getByTestId("approve-proposal-prop-1"));
    expect(onApprove).toHaveBeenCalledWith("prop-1", "approved from console rain clearing");
    await userEvent.click(screen.getByTestId("reject-proposal-prop-1"));
    expect(onReject).toHaveBeenCalledWith("prop-1", "approved from console rain clearing");
  });

  it("prefers weather-hold candidates in the request-proposal selector", () => {
    render(
      <ProposalReview
        proposals={[shiftProposal]}
        candidateRobots={["husqvarna-1"]}
        allRobotIds={["greenworks-1", "husqvarna-1", "navimow-1"]}
        busy={false}
        onRequest={() => {}}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByTestId("request-robot").textContent).toContain("husqvarna-1 (weather hold)");
  });

  it("summarizes decided proposals in history", () => {
    render(
      <ProposalReview
        proposals={[swapProposal]}
        candidateRobots={[]}
        allRobotIds={["navimow-1"]}
        busy={false}
        onRequest={() => {}}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByText("Decided proposals (1)")).toBeInTheDocument();
    expect(screen.getByText(/swap task-2 ↔ task-3 · operator on site/)).toBeInTheDocument();
  });
});
