import type { TelemetrySample } from "@fleetos/core-schema";
import { createGreenworksMowerAdapter, ManualClock } from "@fleetos/adapters-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createWorldModel } from "../src/index.js";
import type { FleetWorldModel } from "../src/index.js";
import { at, mowerRobot, sampleAt, scrubberRobot } from "./helpers.js";

/**
 * The shadow reflects simulator telemetry streams — wired the way the API
 * will wire it: listRobots() builds the registry, subscriptions feed ingest,
 * and the slice always equals the newest emitted sample.
 */
describe("digital shadow over a Greenworks simulator stream", () => {
  let clock: ManualClock;
  let adapter: ReturnType<typeof createGreenworksMowerAdapter>;
  let model: FleetWorldModel;
  let samples: TelemetrySample[];
  let primaryId: string;
  let secondaryId: string;

  beforeEach(async () => {
    clock = new ManualClock("2026-11-02T08:00:00Z");
    adapter = createGreenworksMowerAdapter({ clock });
    await adapter.connect();
    const robots = await adapter.listRobots();
    primaryId = robots[0]?.robotId ?? "";
    secondaryId = robots[1]?.robotId ?? "";
    model = createWorldModel({ robots, clock });
    samples = [];
    adapter.subscribeTelemetry((sample) => {
      samples.push(sample);
      model.ingest(sample);
    });
    adapter.subscribeFaults((fault) => {
      model.ingest(fault);
    });
  });

  it("tracks the emitted telemetry sample exactly", () => {
    adapter.tick();
    adapter.tick();

    const primarySamples = samples.filter((sample) => sample.robotId === primaryId);
    const last = primarySamples[primarySamples.length - 1];
    expect(last).toBeDefined();
    const slice = model.sliceFor(primaryId);
    expect(slice).not.toBeNull();
    expect(slice?.batteryPct).toBe(last?.batteryPct);
    expect(slice?.charging).toBe(last?.charging);
    expect(slice?.pose).toEqual(last?.pose);
    expect(slice?.lastTelemetryAt).toBe(last?.ts);
    expect(slice?.state).toBe("idle");
    expect(slice?.confidence).toBeCloseTo(0.95, 5); // fresh, fault-free
    expect(slice?.dataAgeSeconds).toBeCloseTo(60, 5); // tick emits, then advances the clock
  });

  it("moves to executing on task progress and picks up active faults", async () => {
    adapter.tick();
    await adapter.sendCommand({ robotId: primaryId, command: "START_TASK" });
    adapter.tick();
    expect(model.sliceFor(primaryId)?.state).toBe("executing");
    expect(model.sliceFor(primaryId)?.progressPct).not.toBeNull();

    adapter.injectFaultProfile();

    // The seeded profile ends with MAINTENANCE_DUE on the primary and
    // WEATHER_HOLD on the secondary — each is that robot's active fault.
    const primary = model.sliceFor(primaryId);
    expect(primary?.state).toBe("faulted");
    expect(primary?.activeFault?.type).toBe("MAINTENANCE_DUE");
    expect(primary?.lastFault?.type).toBe("MAINTENANCE_DUE");
    const secondary = model.sliceFor(secondaryId);
    expect(secondary?.state).toBe("faulted");
    expect(secondary?.activeFault?.type).toBe("WEATHER_HOLD");
  });

  it("clears a COMMS_LOST fault when the link's fresh telemetry returns", async () => {
    adapter.tick();
    await adapter.dropTransport(); // emits COMMS_LOST on the primary, then reconnects
    const dropped = model.sliceFor(primaryId);
    expect(dropped?.state).toBe("unreachable");
    expect(dropped?.activeFault?.type).toBe("COMMS_LOST");
    const droppedConfidence = dropped?.confidence ?? 0;
    expect(droppedConfidence).toBeLessThan(model.sliceFor(secondaryId)?.confidence ?? 0);

    // The link returns in a LATER telemetry interval — the adapter stamps the
    // fault at clock time and the next tick's sample would share that instant,
    // so step one interval first (recovery needs ts strictly after the fault).
    clock.advanceSeconds(60);
    adapter.tick(); // reconnected uplink emits fresh telemetry
    const restored = model.sliceFor(primaryId);
    expect(restored?.activeFault).toBeNull();
    expect(restored?.state).toBe("idle");
    expect(restored?.confidence).toBeGreaterThan(droppedConfidence);
  });
});

describe("digital shadow over direct ingest (scripted stream)", () => {
  let clock: ManualClock;
  let model: FleetWorldModel;

  beforeEach(() => {
    clock = new ManualClock(at(0));
    model = createWorldModel({ robots: [mowerRobot(), scrubberRobot()], clock });
  });

  it("starts unseen with null observations and zero confidence", () => {
    const slice = model.sliceFor("robot-mower-01");
    expect(slice?.state).toBe("unseen");
    expect(slice?.batteryPct).toBeNull();
    expect(slice?.dataAgeSeconds).toBeNull();
    expect(slice?.confidence).toBe(0);
    expect(slice?.activeConstraintPacks).toEqual([]);
  });

  it("reflects ingested samples with battery, pose, progress, and task", () => {
    model.assignTask("robot-mower-01", "task-2026-11-02-001");
    model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 64.5, progressPct: 30 }));

    const slice = model.sliceFor("robot-mower-01");
    expect(slice?.batteryPct).toBe(64.5);
    expect(slice?.progressPct).toBe(30);
    expect(slice?.currentTaskId).toBe("task-2026-11-02-001");
    expect(slice?.state).toBe("executing");
    expect(slice?.lastTelemetryAt).toBe(at(0));
  });

  it("keeps the snapshot sorted by robotId with every registered robot", () => {
    const snapshot = model.snapshot();
    expect(snapshot.robots.map((slice) => slice.robotId)).toEqual([
      "robot-mower-01",
      "robot-scrubber-01",
    ]);
  });

  it("ignores out-of-order samples instead of making the shadow younger", () => {
    model.ingest(sampleAt(at(120), "robot-mower-01", { batteryPct: 70 }));
    model.ingest(sampleAt(at(60), "robot-mower-01", { batteryPct: 99 }));
    expect(model.sliceFor("robot-mower-01")?.batteryPct).toBe(70);
    expect(model.sliceFor("robot-mower-01")?.lastTelemetryAt).toBe(at(120));
  });

  it("throws typed errors for unregistered robots and malformed ids", () => {
    expect(() => model.ingest(sampleAt(at(0), "ghost-robot"))).toThrowError(/not registered/);
    expect(() => model.confidence("ghost-robot")).toThrowError(/not registered/);
    expect(() => model.assignSite("ghost-robot", "site-x")).toThrowError(/not registered/);
    expect(() => model.assignTask("robot-mower-01", "bad id with spaces")).toThrowError(
      /entity id/,
    );
    expect(model.sliceFor("ghost-robot")).toBeNull();
  });
});
