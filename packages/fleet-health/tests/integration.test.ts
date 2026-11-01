import { describe, expect, it } from "vitest";

import { ManualClock, createGreenworksMowerAdapter } from "@fleetos/adapters-sdk";
import type { RobotAdapter } from "@fleetos/adapters-sdk";
import { createDeviceAgent } from "@fleetos/device-agents";
import { createWorldModel } from "@fleetos/world-model";
import type { FaultEvent, Robot, TelemetrySample } from "@fleetos/core-schema";

import { createFleetHealthEngine } from "../src/engine.js";

/**
 * End-to-end verification against a real simulator adapter (spec acceptance:
 * "inject a seeded BATTERY fault from a simulator, assert an exception is
 * queued and affected tasks enter HELD; PAUSE + RESUME interventions append
 * audit entries; comms-loss scenario asserts DEGRADED state and telemetry
 * exclusion"). The Greenworks adapter's ManualClock drives both the
 * simulator and the engine, so the whole trace is deterministic.
 */

const START = "2026-11-02T08:00:00.000Z";

interface Wire {
  readonly faults: FaultEvent[];
  readonly samples: TelemetrySample[];
  readonly unsubscribe: () => void;
}

function wireAdapter(adapter: RobotAdapter): Wire {
  const faults: FaultEvent[] = [];
  const samples: TelemetrySample[] = [];
  const offFaults = adapter.subscribeFaults((fault) => faults.push(fault));
  const offTelemetry = adapter.subscribeTelemetry((sample) => samples.push(sample));
  return {
    faults,
    samples,
    unsubscribe: () => {
      offFaults();
      offTelemetry();
    },
  };
}

async function connectedAdapter(clock: ManualClock) {
  const adapter = createGreenworksMowerAdapter({ clock });
  await adapter.connect();
  return adapter;
}

describe("seeded BATTERY fault from a simulator", () => {
  it("queues an exception, holds the affected task, and takes the agent diagnosis", async () => {
    const clock = new ManualClock(START);
    const adapter = await connectedAdapter(clock);
    const wire = wireAdapter(adapter);
    const engine = createFleetHealthEngine({ clock });

    const robots: readonly Robot[] = await adapter.listRobots();
    const primary = robots[0];
    if (!primary) throw new Error("greenworks simulator has no robots");
    engine.assignTask(primary.robotId, "task-mow-01");

    // The adapter's seeded fault profile emits all six normalized classes;
    // its first event is the vendor's BATTERY fault on the primary mower.
    adapter.injectFaultProfile();
    const battery = wire.faults.find((fault) => fault.type === "BATTERY");
    if (!battery) throw new Error("expected a BATTERY fault in the seeded profile");

    const result = engine.ingestFault(battery);
    expect(result.exception).not.toBeNull();
    const exception = engine.exception(result.exception?.exceptionId ?? "");
    expect(exception.type).toBe("BATTERY");
    expect(exception.severity).toBe("critical");
    expect(exception.status).toBe("open");
    expect(exception.taskId).toBe("task-mow-01"); // from the robot's assignment
    expect(engine.taskStatus("task-mow-01")).toBe("held");

    // The device agent self-diagnoses the same fault through the fleet-health
    // audit log — fleet-health is the persistent AgentAuditSink implementation.
    const agent = createDeviceAgent({ robot: primary, audit: engine.audit, clock });
    const diagnosis = agent.reportFault(battery);
    const refined = engine.recordDiagnosis(diagnosis);
    expect(refined?.suggestedRecovery).toBe(
      primary.capabilities.remoteResume ? "dock-charge" : "human-service",
    );
    expect(engine.audit.entries().some((entry) => entry.action === "agent-diagnosis")).toBe(true);
    // A diagnosis for an untracked fault is typed absence, not an error.
    expect(
      engine.recordDiagnosis({
        ...diagnosis,
        diagnosisId: "diag-other",
        faultId: "fault-never-seen",
      }),
    ).toBeNull();

    // The human path: acknowledge, then pause + resume through the audited
    // command surface, then release — every step lands in the trail.
    engine.acknowledgeException(exception.exceptionId, "op-1");
    await adapter.sendCommand({ robotId: primary.robotId, command: "PAUSE" });
    engine.recordIntervention({
      robotId: primary.robotId,
      kind: "pause",
      operatorId: "op-1",
      reason: "battery exception: hold the mower",
      taskId: "task-mow-01",
      planId: "plan-1",
    });
    await adapter.sendCommand({ robotId: primary.robotId, command: "RESUME" });
    engine.recordIntervention({
      robotId: primary.robotId,
      kind: "resume",
      operatorId: "op-1",
      reason: "battery confirmed recovering",
      taskId: "task-mow-01",
      planId: "plan-1",
    });

    const audit = engine.audit.entries();
    const pause = audit.filter((entry) => entry.action === "intervention-pause");
    const resume = audit.filter((entry) => entry.action === "intervention-resume");
    expect(pause).toHaveLength(1);
    expect(resume).toHaveLength(1);
    for (const entry of [...pause, ...resume]) {
      expect(entry.actorType).toBe("operator");
      expect(entry.actorId).toBe("op-1");
      expect(entry.planId).toBe("plan-1"); // plan version in effect
      expect(entry.subjectId).toBe(primary.robotId);
    }

    const released = engine.releaseException(exception.exceptionId, "op-1", "battery recovering");
    expect(released.status).toBe("released");
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");
    adapter.disconnect();
    wire.unsubscribe();
  });
});

describe("comms-loss scenario", () => {
  it("marks DEGRADED, excludes telemetry, and self-releases on the link returning", async () => {
    const clock = new ManualClock(START);
    const adapter = await connectedAdapter(clock);
    const wire = wireAdapter(adapter);
    const engine = createFleetHealthEngine({ clock });
    const world = createWorldModel({ robots: await adapter.listRobots(), clock });

    const robots: readonly Robot[] = await adapter.listRobots();
    const primary = robots[0];
    if (!primary) throw new Error("greenworks simulator has no robots");
    engine.assignTask(primary.robotId, "task-mow-01");

    // One healthy tick: telemetry flows and is admitted.
    adapter.tick();
    for (const sample of wire.samples) {
      engine.ingestTelemetry(sample);
      world.ingest(sample);
    }
    expect(engine.healthOf(primary.robotId)).toBe("healthy"); // telemetry seen, no fault

    // The transport drops: the adapter emits COMMS_LOST for the primary mower.
    await adapter.dropTransport();
    const commsLoss = wire.faults.filter((fault) => fault.type === "COMMS_LOST");
    expect(commsLoss).toHaveLength(1);
    engine.ingestFault(commsLoss[0] as FaultEvent);
    expect(engine.healthOf(primary.robotId)).toBe("degraded");
    expect(engine.degradedRobots()).toEqual(new Set([primary.robotId]));
    // The world model agrees the robot is unreachable — same stream, same verdict.
    world.ingest(commsLoss[0] as FaultEvent);
    expect(world.sliceFor(primary.robotId)?.state).toBe("unreachable");
    expect(world.sliceFor(primary.robotId)?.confidence).toBeLessThan(0.5);

    // While degraded, the robot's telemetry is excluded from optimization.
    // The first tick after the drop samples at the same instant as the fault
    // (the adapter stamps both from the same clock reading), so it is stale
    // evidence — excluded AND not sufficient to restore the link.
    adapter.tick();
    const sameInstantSample = wire.samples
      .filter((sample) => sample.robotId === primary.robotId)
      .at(-1);
    if (!sameInstantSample) throw new Error("expected telemetry after the drop tick");
    expect(engine.admitTelemetry(sameInstantSample)).toBe(false);
    expect(engine.ingestTelemetry(sameInstantSample).linkRestored).toBe(false);
    expect(engine.healthOf(primary.robotId)).toBe("degraded");

    // The next tick's sample is strictly after the fault: the restoring
    // sample is still excluded (it was not trusted data), but it proves the
    // link back — the exception auto-releases and the held task returns to
    // its prior status, no human touch needed for this class.
    adapter.tick();
    const freshSample = wire.samples.filter((sample) => sample.robotId === primary.robotId).at(-1);
    if (!freshSample) throw new Error("expected fresh telemetry for the primary mower");
    expect(engine.admitTelemetry(freshSample)).toBe(false);
    const restore = engine.ingestTelemetry(freshSample);
    expect(restore).toEqual({ admitted: false, linkRestored: true });
    expect(engine.healthOf(primary.robotId)).toBe("healthy");
    world.ingest(freshSample);
    expect(world.sliceFor(primary.robotId)?.state).not.toBe("unreachable");

    const commsException = engine.exceptions().find((record) => record.type === "COMMS_LOST");
    if (!commsException) throw new Error("expected a COMMS_LOST exception");
    expect(engine.exception(commsException.exceptionId).status).toBe("released");
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");
    adapter.disconnect();
  });

  it("survives a seeded multi-window connectivity scenario", async () => {
    const clock = new ManualClock(START);
    const adapter = await connectedAdapter(clock);
    const wire = wireAdapter(adapter);
    const engine = createFleetHealthEngine({ clock });

    const robots: readonly Robot[] = await adapter.listRobots();
    const primary = robots[0];
    if (!primary) throw new Error("greenworks simulator has no robots");
    engine.assignTask(primary.robotId, "task-mow-01");

    const drops = adapter.armConnectivityScenario(42);
    const primaryDrops = drops.filter((drop) => drop.robotId === primary.robotId);
    expect(primaryDrops.length).toBeGreaterThanOrEqual(1);

    let sawDegraded = false;
    let sawExcludedTelemetry = false;
    for (let tick = 0; tick < 14; tick += 1) {
      adapter.tick();
      const tickFaults = [...wire.faults];
      wire.faults.length = 0;
      const tickSamples = [...wire.samples];
      wire.samples.length = 0;
      for (const fault of tickFaults) engine.ingestFault(fault);
      for (const sample of tickSamples) {
        if (!engine.admitTelemetry(sample)) sawExcludedTelemetry = true;
        engine.ingestTelemetry(sample);
      }
      if (engine.healthOf(primary.robotId) === "degraded") sawDegraded = true;
    }

    // The primary mower was DEGRADED during its drop windows, its telemetry
    // was excluded there, and every link restored by the end of the schedule.
    expect(sawDegraded).toBe(true);
    expect(sawExcludedTelemetry).toBe(true);
    expect(engine.healthOf(primary.robotId)).toBe("healthy");
    expect(engine.degradedRobots().size).toBe(0);
    for (const record of engine.exceptions()) {
      if (record.type === "COMMS_LOST") {
        expect(engine.exception(record.exceptionId).status).toBe("released");
      }
    }
    expect(engine.taskStatus("task-mow-01")).toBe("scheduled");
    adapter.disconnect();
  });
});
