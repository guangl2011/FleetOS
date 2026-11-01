import { describe, expect, it } from "vitest";

import { diagnoseFault, escalatedSeverity, suggestedRecoveryKind } from "../src/index.js";
import type { AssignedEnvelope } from "@fleetos/scheduler";

import { envelope, faultEvent, mowerRobot } from "./builders.js";
import type { FaultEvent } from "@fleetos/core-schema";

describe("suggestedRecoveryKind", () => {
  it("sends a commandable robot to its dock on battery faults", () => {
    expect(suggestedRecoveryKind("BATTERY", true)).toBe("dock-charge");
  });

  it("calls a human for battery faults when the robot cannot be commanded", () => {
    expect(suggestedRecoveryKind("BATTERY", false)).toBe("human-service");
  });

  it("always treats stuck as physical", () => {
    expect(suggestedRecoveryKind("STUCK", true)).toBe("human-service");
    expect(suggestedRecoveryKind("STUCK", false)).toBe("human-service");
  });

  it("maps the remaining taxonomy", () => {
    expect(suggestedRecoveryKind("SENSOR_DEGRADED", true)).toBe("resume");
    expect(suggestedRecoveryKind("COMMS_LOST", true)).toBe("resume");
    expect(suggestedRecoveryKind("COMMS_LOST", false)).toBe("human-service");
    expect(suggestedRecoveryKind("WEATHER_HOLD", true)).toBe("resume");
    expect(suggestedRecoveryKind("MAINTENANCE_DUE", true)).toBe("reassign");
  });
});

describe("escalatedSeverity", () => {
  const env: AssignedEnvelope = envelope();

  it("escalates a human-touch fault that interrupts the assigned task to critical", () => {
    const fault: FaultEvent = faultEvent({
      type: "BATTERY",
      severity: "warning",
      taskId: "task-mow-01",
    });
    expect(escalatedSeverity(fault, env)).toBe("critical");
  });

  it("keeps the normalized severity when the fault is off-task", () => {
    const fault: FaultEvent = faultEvent({
      type: "BATTERY",
      severity: "warning",
      taskId: "task-other",
    });
    expect(escalatedSeverity(fault, env)).toBe("warning");
  });

  it("keeps the normalized severity with no envelope in force", () => {
    const fault: FaultEvent = faultEvent({
      type: "BATTERY",
      severity: "warning",
      taskId: "task-mow-01",
    });
    expect(escalatedSeverity(fault, null)).toBe("warning");
  });

  it("never escalates non-human-touch classes", () => {
    const fault: FaultEvent = faultEvent({
      type: "WEATHER_HOLD",
      severity: "info",
      taskId: "task-mow-01",
    });
    expect(escalatedSeverity(fault, env)).toBe("info");
  });

  it("keeps a critical fault critical", () => {
    const fault: FaultEvent = faultEvent({
      type: "STUCK",
      severity: "critical",
      taskId: "task-mow-01",
    });
    expect(escalatedSeverity(fault, env)).toBe("critical");
  });
});

describe("diagnoseFault (deterministic v1)", () => {
  it("produces severity and a suggested recovery with rationale", () => {
    const diagnosis = diagnoseFault(
      faultEvent({ type: "BATTERY", severity: "critical", taskId: "task-mow-01" }),
      mowerRobot(),
      envelope(),
    );
    expect(diagnosis.severity).toBe("critical");
    expect(diagnosis.suggestedRecovery.kind).toBe("dock-charge");
    expect(diagnosis.suggestedRecovery.rationale).toContain("dock");
    expect(diagnosis.selfClearing).toBe(false);
    expect(diagnosis.robotId).toBe("robot-mower-01");
    expect(diagnosis.summary).toContain("BATTERY");
  });

  it("marks weather holds self-clearing", () => {
    const diagnosis = diagnoseFault(faultEvent(), mowerRobot(), envelope());
    expect(diagnosis.selfClearing).toBe(true);
    expect(diagnosis.suggestedRecovery.kind).toBe("resume");
  });

  it("suggests human service for a battery fault on a non-commandable robot", () => {
    const robot = mowerRobot({
      capabilities: { ...mowerRobot().capabilities, remoteResume: false },
    });
    const diagnosis = diagnoseFault(
      faultEvent({ type: "BATTERY", severity: "critical" }),
      robot,
      envelope(),
    );
    expect(diagnosis.suggestedRecovery.kind).toBe("human-service");
  });
});
