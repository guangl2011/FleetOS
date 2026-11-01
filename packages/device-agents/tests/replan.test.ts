import { describe, expect, it } from "vitest";

import { reviewReplanProposal } from "../src/index.js";
import type {
  ReplanProposal,
  ReplanReviewContext,
  SwapTasksProposal,
  ShiftStartProposal,
} from "../src/index.js";

import {
  T0_MINUS_5M,
  T0_PLUS_10M,
  T0_PLUS_11M,
  T0_PLUS_5M,
  envelope,
  noisePack,
} from "./builders.js";

function context(overrides: Partial<ReplanReviewContext> = {}): ReplanReviewContext {
  return {
    robotId: "robot-mower-01",
    envelope: envelope(),
    packs: [],
    robotKind: "mower",
    localOffsetMinutes: 0,
    ...overrides,
  };
}

function swap(overrides: Partial<SwapTasksProposal> = {}): SwapTasksProposal {
  return {
    kind: "swap-tasks",
    proposalId: "prop-swap-1",
    robotId: "robot-mower-01",
    envelopeId: "env-robot-mower-01-task-mow-01",
    createdAt: T0_MINUS_5M,
    taskIdA: "task-mow-01",
    taskIdB: "task-mow-02",
    reason: "shorter task first",
    ...overrides,
  };
}

function shift(overrides: Partial<ShiftStartProposal> = {}): ShiftStartProposal {
  return {
    kind: "shift-start",
    proposalId: "prop-shift-1",
    robotId: "robot-mower-01",
    envelopeId: "env-robot-mower-01-task-mow-01",
    createdAt: T0_MINUS_5M,
    taskId: "task-mow-01",
    newStartAt: T0_PLUS_5M,
    reason: "wait out hold",
    ...overrides,
  };
}

describe("reviewReplanProposal — accepted in-envelope moves", () => {
  it("accepts a swap of the assigned task with a swap-set task", () => {
    const review = reviewReplanProposal(swap(), context());
    expect(review).toStrictEqual({ accepted: true, proposalId: "prop-swap-1" });
  });

  it("accepts a swap of two swap-set tasks", () => {
    const review = reviewReplanProposal(
      swap({ taskIdA: "task-mow-02", taskIdB: "task-mow-03", proposalId: "prop-swap-2" }),
      context({ envelope: envelope({ swappableTaskIds: ["task-mow-02", "task-mow-03"] }) }),
    );
    expect(review).toStrictEqual({ accepted: true, proposalId: "prop-swap-2" });
  });

  it("accepts shifts within tolerance in either direction", () => {
    for (const newStartAt of [T0_PLUS_5M, T0_MINUS_5M, T0_PLUS_10M]) {
      const review = reviewReplanProposal(shift({ newStartAt }), context());
      expect(review.accepted).toBe(true);
    }
  });
});

describe("reviewReplanProposal — out-of-envelope rejections", () => {
  it("rejects a proposal for another robot", () => {
    const review = reviewReplanProposal(swap({ robotId: "robot-mower-02" }), context());
    expect(review).toMatchObject({ accepted: false, code: "ROBOT_MISMATCH" });
  });

  it("rejects any proposal when the agent holds no envelope", () => {
    const review = reviewReplanProposal(shift(), context({ envelope: null }));
    expect(review).toMatchObject({ accepted: false, code: "ENVELOPE_UNKNOWN" });
  });

  it("rejects a proposal bound to a stale envelope", () => {
    const review = reviewReplanProposal(
      shift({ envelopeId: "env-robot-mower-01-task-mow-old" }),
      context(),
    );
    expect(review).toMatchObject({ accepted: false, code: "ENVELOPE_MISMATCH" });
  });

  it("rejects a swap that reaches outside the swap set", () => {
    const review = reviewReplanProposal(swap({ taskIdB: "task-mow-99" }), context());
    expect(review).toMatchObject({ accepted: false, code: "SWAP_OUTSIDE_ENVELOPE" });
  });

  it("rejects an identical swap", () => {
    const review = reviewReplanProposal(swap({ taskIdB: "task-mow-01" }), context());
    expect(review).toMatchObject({ accepted: false, code: "SWAP_TASKS_IDENTICAL" });
  });

  it("rejects a shift of a task the agent does not own", () => {
    const review = reviewReplanProposal(shift({ taskId: "task-mow-02" }), context());
    expect(review).toMatchObject({ accepted: false, code: "TASK_OUTSIDE_ENVELOPE" });
  });

  it("rejects a shift beyond tolerance — one minute past the boundary fails", () => {
    const review = reviewReplanProposal(shift({ newStartAt: T0_PLUS_11M }), context());
    expect(review).toMatchObject({ accepted: false, code: "SHIFT_EXCEEDS_TOLERANCE" });
  });

  it("rejects an unparseable start time", () => {
    const review = reviewReplanProposal(shift({ newStartAt: "not-a-timestamp" }), context());
    expect(review).toMatchObject({ accepted: false, code: "START_TIME_INVALID" });
  });
});

describe("reviewReplanProposal — hard-constraint safety", () => {
  it("accepts a daytime shift under a night noise ordinance", () => {
    const review = reviewReplanProposal(
      shift({ newStartAt: T0_PLUS_10M }),
      context({ packs: [noisePack()] }),
    );
    expect(review.accepted).toBe(true);
  });

  it("rejects a shift whose work interval would overlap the forbidden window", () => {
    // Assigned 21:00–23:00 UTC; every tolerated shift still ends past 22:00.
    const nightEnvelope = envelope({
      assignedStartAt: "2026-11-02T21:00:00.000Z",
      assignedEndAt: "2026-11-02T23:00:00.000Z",
    });
    const review = reviewReplanProposal(
      shift({ newStartAt: "2026-11-02T21:10:00.000Z" }),
      context({ envelope: nightEnvelope, packs: [noisePack()] }),
    );
    expect(review).toMatchObject({ accepted: false, code: "HARD_WINDOW_CONFLICT" });
  });

  it("accepts the max-tolerance shift that clears the forbidden window exactly", () => {
    // Assigned 06:50–07:00 UTC; the forbidden window ends at 07:00 (half-open
    // — 07:00 itself is clear). The zero-shift proposal overlaps the window
    // and is rejected; the max-tolerance shift lands exactly on the boundary.
    const earlyEnvelope = envelope({
      assignedStartAt: "2026-11-02T06:50:00.000Z",
      assignedEndAt: "2026-11-02T07:00:00.000Z",
    });
    const zeroShift = reviewReplanProposal(
      shift({ newStartAt: "2026-11-02T06:50:00.000Z" }),
      context({ envelope: earlyEnvelope, packs: [noisePack()] }),
    );
    expect(zeroShift).toMatchObject({ accepted: false, code: "HARD_WINDOW_CONFLICT" });
    const cleared = reviewReplanProposal(
      shift({ newStartAt: "2026-11-02T07:00:00.000Z" }),
      context({ envelope: earlyEnvelope, packs: [noisePack()] }),
    );
    expect(cleared).toStrictEqual({ accepted: true, proposalId: "prop-shift-1" });
  });
});

describe("reviewReplanProposal — type-level boundary", () => {
  it("narrows the discriminated union", () => {
    const proposals: ReplanProposal[] = [swap(), shift()];
    const kinds = proposals.map((proposal) => proposal.kind);
    expect(kinds).toStrictEqual(["swap-tasks", "shift-start"]);
  });
});
