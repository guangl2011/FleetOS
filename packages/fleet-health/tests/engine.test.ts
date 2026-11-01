import { describe, expect, it } from "vitest";

import { ManualClock } from "@fleetos/adapters-sdk";

import { createFleetHealthEngine } from "../src/engine.js";
import { FleetHealthError } from "../src/errors.js";
import { faultEvent, telemetrySample, T0 } from "./builders.js";

const CLOCK = new ManualClock(T0);

function makeEngine() {
  return createFleetHealthEngine({ clock: CLOCK });
}

describe("exception queue lifecycle", () => {
  it("opens one exception per fault and is idempotent on faultId", () => {
    const engine = makeEngine();
    const first = engine.ingestFault(faultEvent());
    expect(first.exception).not.toBeNull();
    const replay = engine.ingestFault(faultEvent());
    expect(replay.exception?.exceptionId).toBe(first.exception?.exceptionId);
    expect(engine.exceptions()).toHaveLength(1);
    // No duplicate audit entries for the replay.
    const opened = engine.audit.entries().filter((entry) => entry.action === "exception-opened");
    expect(opened).toHaveLength(1);
  });

  it("acknowledge then release, and refuses invalid transitions", () => {
    const engine = makeEngine();
    const exception = engine.ingestFault(faultEvent()).exception;
    if (!exception) throw new Error("expected an exception for a critical BATTERY fault");

    const acknowledged = engine.acknowledgeException(exception.exceptionId, "op-1");
    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.acknowledgedAt).toBe(T0);

    // Re-acknowledging an acknowledged exception is refused, not silently ignored.
    expect(() => engine.acknowledgeException(exception.exceptionId, "op-1")).toThrowError(
      FleetHealthError,
    );

    const released = engine.releaseException(exception.exceptionId, "op-1", "battery replaced");
    expect(released.status).toBe("released");
    expect(released.releasedReason).toBe("battery replaced");
    expect(() => engine.releaseException(exception.exceptionId, "op-1", "again")).toThrowError(
      FleetHealthError,
    );
    expect(engine.openExceptions()).toHaveLength(0);
  });

  it("throws EXCEPTION_UNKNOWN for an id that was never opened", () => {
    const engine = makeEngine();
    try {
      engine.exception("exception-never-opened");
      expect.unreachable("expected EXCEPTION_UNKNOWN");
    } catch (error) {
      expect(error).toBeInstanceOf(FleetHealthError);
      expect((error as FleetHealthError).code).toBe("EXCEPTION_UNKNOWN");
    }
  });

  it("holds the affected task and restores its prior status on release", () => {
    const engine = makeEngine();
    engine.assignTask("robot-mower-01", "task-mow-01");
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");

    const exception = engine.ingestFault(faultEvent({ taskId: "task-mow-01" })).exception;
    if (!exception) throw new Error("expected an exception");
    expect(engine.taskStatus("task-mow-01")).toBe("held");
    expect(engine.heldTasks()).toEqual(["task-mow-01"]);

    engine.releaseException(exception.exceptionId, "op-1", "resolved");
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");
    expect(engine.heldTasks()).toHaveLength(0);
  });

  it("does not hold the task twice when two faults hit the same assignment", () => {
    const engine = makeEngine();
    engine.assignTask("robot-mower-01", "task-mow-01");
    engine.ingestFault(faultEvent());
    engine.ingestFault(
      faultEvent({ faultId: "fault-robot-mower-01-STUCK-1", type: "STUCK", severity: "warning" }),
    );
    expect(engine.heldTasks()).toEqual(["task-mow-01"]);
    expect(engine.audit.entries().filter((entry) => entry.action === "task-held")).toHaveLength(1);
  });

  it("prefers the fault's own taskId over the robot's assignment", () => {
    const engine = makeEngine();
    engine.assignTask("robot-mower-01", "task-mow-01");
    engine.ingestFault(faultEvent({ taskId: "task-mow-99" }));
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");
    expect(engine.taskStatus("task-mow-99")).toBe("held");
  });
});

describe("interventions", () => {
  it("records PAUSE and RESUME with operator, timestamp, and plan version in effect", () => {
    const engine = makeEngine();
    const pause = engine.recordIntervention({
      robotId: "robot-mower-01",
      kind: "pause",
      operatorId: "op-1",
      reason: "battery exception open",
      taskId: "task-mow-01",
      planId: "plan-1",
    });
    const resume = engine.recordIntervention({
      robotId: "robot-mower-01",
      kind: "resume",
      operatorId: "op-1",
      reason: "operator confirmed safe to continue",
      taskId: "task-mow-01",
      planId: "plan-1",
    });
    expect(pause.kind).toBe("pause");
    expect(resume.kind).toBe("resume");
    expect(engine.interventions()).toHaveLength(2);

    const pauseEntries = engine.audit
      .entries()
      .filter((entry) => entry.action === "intervention-pause");
    expect(pauseEntries).toHaveLength(1);
    const entry = pauseEntries[0];
    if (!entry) throw new Error("expected an intervention-pause audit entry");
    expect(entry.actorType).toBe("operator");
    expect(entry.actorId).toBe("op-1");
    expect(entry.at).toBe(T0);
    expect(entry.planId).toBe("plan-1");
    expect(entry.subjectType).toBe("robot");
    expect(entry.subjectId).toBe("robot-mower-01");

    const resumeEntries = engine.audit
      .entries()
      .filter((entry) => entry.action === "intervention-resume");
    expect(resumeEntries).toHaveLength(1);
  });

  it("refuses interventions that violate the core-schema Intervention schema", () => {
    const engine = makeEngine();
    expect(() =>
      engine.recordIntervention({
        robotId: "robot mower 01", // space — violates the entity-id pattern
        kind: "pause",
        operatorId: "op-1",
        reason: "bad robot id",
      }),
    ).toThrowError(/Intervention schema/);
    expect(engine.interventions()).toHaveLength(0);
  });
});

describe("degraded mode through the engine", () => {
  it("marks DEGRADED on comms loss, excludes telemetry, and auto-releases on restore", () => {
    const engine = makeEngine();
    engine.assignTask("robot-mower-01", "task-mow-01");

    const result = engine.ingestFault(
      faultEvent({ type: "COMMS_LOST", message: "vendor uplink lost" }),
    );
    expect(result.exception?.marksDegraded).toBe(true);
    expect(engine.healthOf("robot-mower-01")).toBe("degraded");
    expect(engine.degradedRobots()).toEqual(new Set(["robot-mower-01"]));
    expect(engine.admitTelemetry(telemetrySample())).toBe(false);

    // Fresh telemetry proves the link back: the restoring sample is excluded,
    // everything after it is admitted, the exception releases itself, and the
    // held task returns to its prior status — no human touch for this class.
    const restore = engine.ingestTelemetry(telemetrySample({ ts: "2026-11-02T08:01:00.000Z" }));
    expect(restore).toEqual({ admitted: false, linkRestored: true });
    expect(engine.healthOf("robot-mower-01")).toBe("healthy");
    const released = result.exception ? engine.exception(result.exception.exceptionId) : null;
    expect(released?.status).toBe("released");
    expect(released?.releasedReason).toBe("fresh telemetry restored the link");
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");
    expect(engine.admitTelemetry(telemetrySample({ ts: "2026-11-02T08:02:00.000Z" }))).toBe(true);

    const restored = engine.audit
      .entries()
      .filter((entry) => entry.action === "telemetry-restored");
    expect(restored).toHaveLength(1);
  });

  it("never auto-releases a BATTERY exception on fresh telemetry", () => {
    const engine = makeEngine();
    const exception = engine.ingestFault(faultEvent()).exception;
    if (!exception) throw new Error("expected an exception");
    engine.ingestTelemetry(telemetrySample({ ts: "2026-11-02T08:01:00.000Z" }));
    expect(exception.status).toBe("open");
    expect(engine.openExceptions()).toHaveLength(1);
  });
});
