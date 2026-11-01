import { ManualClock } from "@fleetos/adapters-sdk";
import { describe, expect, it } from "vitest";

import { createDeviceAgent, createInMemoryAuditTrail } from "../src/index.js";
import type { ShiftStartProposal } from "../src/index.js";

import {
  T0,
  T0_MINUS_5M,
  T0_PLUS_10M,
  envelope,
  faultEvent,
  mowerRobot,
  noisePack,
  shadowSlice,
} from "./builders.js";

describe("device agent — spec acceptance path", () => {
  it("diagnoses a seeded fault with severity and a suggested recovery, audited", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0),
    });
    agent.observe(shadowSlice({ state: "faulted" }), envelope(), []);
    const diagnosis = agent.reportFault(
      faultEvent({
        type: "BATTERY",
        severity: "critical",
        taskId: "task-mow-01",
        faultId: "fault-battery-1",
        message: "battery below reserve mid-task",
      }),
    );
    expect(diagnosis.severity).toBe("critical");
    expect(diagnosis.suggestedRecovery.kind).toBe("dock-charge");
    expect(diagnosis.diagnosisId).toBe("diag-fault-battery-1");
    const events = trail.entries();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "device-agent",
      action: "agent-diagnosis",
      subjectType: "robot",
      subjectId: "robot-mower-01",
    });
    expect(events[0]?.detail?.severity).toBe("critical");
    expect(events[0]?.detail?.suggestedRecovery).toBe("dock-charge");
  });

  it("rejects and audits an out-of-envelope replan proposal", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0),
    });
    agent.observe(
      shadowSlice({ state: "executing", activeFault: null, lastFault: null }),
      envelope(),
      [],
    );
    const review = agent.reviewProposal({
      kind: "shift-start",
      proposalId: "prop-external-1",
      robotId: "robot-mower-01",
      envelopeId: "env-robot-mower-01-task-mow-01",
      createdAt: T0,
      taskId: "task-not-mine",
      newStartAt: T0_PLUS_10M,
      reason: "a compromised or buggy policy tried to move a foreign task",
    });
    expect(review).toMatchObject({ accepted: false, code: "TASK_OUTSIDE_ENVELOPE" });
    const events = trail.entriesFor("prop-external-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "agent-replan-proposal",
      subjectType: "agent-proposal",
      subjectId: "prop-external-1",
    });
    expect(events[0]?.detail?.review).toBe("rejected");
    expect(events[0]?.detail?.rejectionCode).toBe("TASK_OUTSIDE_ENVELOPE");
  });

  it("proposes an in-envelope wait-out shift for a pre-start weather hold, audited", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0_MINUS_5M), // before the assigned start
    });
    agent.observe(shadowSlice({ state: "faulted" }), envelope(), []);
    const outcome = agent.proposeLocalReplan();
    if (outcome === null) {
      expect.fail("expected a wait-out shift proposal");
    }
    expect(outcome.review).toStrictEqual({
      accepted: true,
      proposalId: outcome.proposal.proposalId,
    });
    const proposal = outcome.proposal as ShiftStartProposal;
    expect(proposal.kind).toBe("shift-start");
    expect(proposal.taskId).toBe("task-mow-01");
    expect(proposal.newStartAt).toBe(T0_PLUS_10M); // the tolerance edge, first candidate
    const events = trail.entriesFor(proposal.proposalId);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail?.review).toBe("accepted");
  });

  it("proposes nothing when every tolerated shift would hit a hard window", () => {
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: createInMemoryAuditTrail(),
      clock: new ManualClock("2026-11-02T20:55:00.000Z"),
    });
    // Assigned 21:00–23:00 under the 22:00–07:00 noise rule: any tolerated
    // shift still ends past 22:00, so the deterministic policy stays silent.
    agent.observe(
      shadowSlice({ activeFault: faultEvent(), lastFault: faultEvent() }),
      envelope({
        assignedStartAt: "2026-11-02T21:00:00.000Z",
        assignedEndAt: "2026-11-02T23:00:00.000Z",
      }),
      [noisePack()],
    );
    expect(agent.proposeLocalReplan()).toBeNull();
  });

  it("yields no proposals without ground truth or without assigned work", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0),
    });
    expect(agent.proposeLocalReplan()).toBeNull(); // never observed
    agent.observe(shadowSlice({ state: "idle", activeFault: null }), null, []);
    expect(agent.proposeLocalReplan()).toBeNull(); // no envelope in force
  });

  it("runs the full audited path: proposal → fault → diagnosis → approval → command", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0_MINUS_5M),
    });
    agent.observe(shadowSlice({ state: "faulted" }), envelope(), []);

    // 1. The agent proposes a bounded wait-out shift and it is audited.
    const outcome = agent.proposeLocalReplan();
    expect(outcome?.review.accepted).toBe(true);

    // 2. A battery fault arrives; the agent self-diagnoses.
    const diagnosis = agent.reportFault(
      faultEvent({
        type: "BATTERY",
        severity: "critical",
        taskId: "task-mow-01",
        faultId: "fault-battery-1",
        message: "battery below reserve mid-task",
      }),
    );

    // 3. Recovery executes only after the recorded human approval.
    agent.decideRecovery({
      diagnosisId: diagnosis.diagnosisId,
      operatorId: "operator-1",
      decision: "approve",
      reason: "clear to dock and recharge",
    });
    const resolution = agent.issueRecoveryCommand(diagnosis.diagnosisId);
    if (resolution.kind !== "command") {
      expect.fail("expected a command resolution");
    }
    expect(resolution.command.permission).toBe("DOCK_CHARGE");

    // 4. Every step is on the trail, append-only with monotonic seq.
    const seqs = trail.entries().map((event) => event.seq);
    expect(seqs).toStrictEqual([1, 2, 3, 4]);
    expect(trail.entries().map((event) => event.action)).toStrictEqual([
      "agent-replan-proposal",
      "agent-diagnosis",
      "recovery-approved",
      "recovery-command-issued",
    ]);
    // Every proposal subject appears exactly once.
    expect(trail.entriesFor(outcome?.proposal.proposalId ?? "")).toHaveLength(1);
    expect(trail.entriesFor(diagnosis.diagnosisId)).toHaveLength(2); // approval + issuance
  });

  it("refuses ground truth and faults for robots it does not own", () => {
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: createInMemoryAuditTrail(),
      clock: new ManualClock(T0),
    });
    expect(() => agent.observe(shadowSlice({ robotId: "robot-mower-02" }), null, [])).toThrowError(
      /owns "robot-mower-01"/,
    );
    expect(() =>
      agent.observe(shadowSlice(), envelope({ robotId: "robot-mower-02" }), []),
    ).toThrowError(/assigned envelope/);
    expect(() => agent.reportFault(faultEvent({ robotId: "robot-mower-02" }))).toThrowError(
      /fault event/,
    );
  });
});
