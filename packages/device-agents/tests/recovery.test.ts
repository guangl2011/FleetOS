import { ManualClock } from "@fleetos/adapters-sdk";
import { describe, expect, it } from "vitest";

import { createDeviceAgent, createInMemoryAuditTrail } from "../src/index.js";
import type { RecoveryResolution } from "../src/index.js";

import { T0, envelope, faultEvent, mowerRobot, shadowSlice } from "./builders.js";

/** A grounded agent with one diagnosed fault (battery, → dock-charge). */
function agentWithBatteryDiagnosis() {
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
  return { agent, trail, diagnosis };
}

function expectAgentError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail(`expected AgentError ${code}`);
  } catch (error) {
    // Re-throw anything that is not the typed error under test.
    if ((error as { code?: string }).code !== code) {
      throw error;
    }
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("the recovery gate", () => {
  it("refuses to issue a recovery command with no human decision", () => {
    const { agent, diagnosis } = agentWithBatteryDiagnosis();
    expectAgentError(() => agent.issueRecoveryCommand(diagnosis.diagnosisId), "APPROVAL_REQUIRED");
  });

  it("refuses to issue a recovery command the human rejected", () => {
    const { agent, diagnosis } = agentWithBatteryDiagnosis();
    agent.decideRecovery({
      diagnosisId: diagnosis.diagnosisId,
      operatorId: "operator-1",
      decision: "reject",
      reason: "operator will service on site instead",
    });
    expectAgentError(() => agent.issueRecoveryCommand(diagnosis.diagnosisId), "APPROVAL_REQUIRED");
  });

  it("issues a DOCK_CHARGE command only after an approval, exactly once", () => {
    const { agent, trail, diagnosis } = agentWithBatteryDiagnosis();
    const decision = agent.decideRecovery({
      diagnosisId: diagnosis.diagnosisId,
      operatorId: "operator-1",
      decision: "approve",
      reason: "clear to dock",
    });
    const resolution: RecoveryResolution = agent.issueRecoveryCommand(diagnosis.diagnosisId);
    if (resolution.kind !== "command") {
      expect.fail("expected a command resolution");
    }
    expect(resolution.command.permission).toBe("DOCK_CHARGE");
    expect(resolution.command.decisionId).toBe(decision.decisionId);
    expect(resolution.command.robotId).toBe("robot-mower-01");
    // Single-use: a consumed approval can never execute a second command.
    expectAgentError(
      () => agent.issueRecoveryCommand(diagnosis.diagnosisId),
      "APPROVAL_ALREADY_USED",
    );
    // The decision and the issuance are both on the trail.
    const events = trail.entriesFor(diagnosis.diagnosisId);
    expect(events.map((event) => event.action)).toContain("recovery-approved");
    expect(events.map((event) => event.action)).toContain("recovery-command-issued");
  });

  it("issues a RESUME command for an approved resume-kind recovery", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0),
    });
    agent.observe(shadowSlice({ state: "degraded" }), envelope(), []);
    const diagnosis = agent.reportFault(
      faultEvent({ type: "SENSOR_DEGRADED", severity: "warning", faultId: "fault-sensor-1" }),
    );
    agent.decideRecovery({
      diagnosisId: diagnosis.diagnosisId,
      operatorId: "operator-1",
      decision: "approve",
      reason: "resume with degraded sensing under monitoring",
    });
    const resolution = agent.issueRecoveryCommand(diagnosis.diagnosisId);
    if (resolution.kind !== "command") {
      expect.fail("expected a command resolution");
    }
    expect(resolution.command.permission).toBe("RESUME");
  });

  it("resolves an approved human-service recovery without any robot command", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0),
    });
    agent.observe(shadowSlice(), envelope(), []);
    const diagnosis = agent.reportFault(
      faultEvent({
        type: "STUCK",
        severity: "critical",
        faultId: "fault-stuck-1",
        taskId: "task-mow-01",
      }),
    );
    agent.decideRecovery({
      diagnosisId: diagnosis.diagnosisId,
      operatorId: "operator-1",
      decision: "approve",
      reason: "dispatch technician",
    });
    const resolution = agent.issueRecoveryCommand(diagnosis.diagnosisId);
    expect(resolution).toStrictEqual({ kind: "no-command", reason: "human-dispatch" });
    const actions = trail.entriesFor(diagnosis.diagnosisId).map((event) => event.action);
    expect(actions).toContain("recovery-approved");
    expect(actions).toContain("recovery-dispatch-requested");
    expect(actions).not.toContain("recovery-command-issued");
  });

  it("resolves an approved reassign recovery as a scheduler action", () => {
    const trail = createInMemoryAuditTrail();
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: trail,
      clock: new ManualClock(T0),
    });
    agent.observe(shadowSlice({ state: "executing" }), envelope(), []);
    const diagnosis = agent.reportFault(
      faultEvent({ type: "MAINTENANCE_DUE", severity: "info", faultId: "fault-maint-1" }),
    );
    agent.decideRecovery({
      diagnosisId: diagnosis.diagnosisId,
      operatorId: "operator-1",
      decision: "approve",
      reason: "move the task, schedule service",
    });
    const resolution = agent.issueRecoveryCommand(diagnosis.diagnosisId);
    expect(resolution).toStrictEqual({ kind: "no-command", reason: "scheduler-reassign" });
  });

  it("rejects decisions on diagnoses it never issued", () => {
    const { agent } = agentWithBatteryDiagnosis();
    expectAgentError(
      () =>
        agent.decideRecovery({
          diagnosisId: "diag-does-not-exist",
          operatorId: "operator-1",
          decision: "approve",
          reason: "bogus",
        }),
      "DIAGNOSIS_MISMATCH",
    );
  });
});
