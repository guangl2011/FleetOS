import { describe, expect, it } from "vitest";

import { createInMemoryAdapter, InMemoryAdapter } from "../src/testing/in-memory-adapter.js";
import { AdapterLifecycleError, AdapterNotConnectedError } from "../src/lifecycle.js";
import { exampleRobotMower } from "@fleetos/core-schema";

describe("InMemoryAdapter registry", () => {
  it("defaults to one mower and one scrubber vendored in-memory-sim", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const robots = await adapter.listRobots();
    expect(robots.map((robot) => robot.robotId)).toEqual([
      "in-memory-mower-01",
      "in-memory-scrubber-01",
    ]);
    expect(robots.map((robot) => robot.kind)).toEqual(["mower", "scrubber"]);
    await adapter.disconnect();
  });

  it("rejects a registry whose vendor does not match the adapter vendor", () => {
    // exampleRobotMower carries vendor "greenworks" — mismatched against "acme".
    expect(() => createInMemoryAdapter({ vendor: "acme", robots: [exampleRobotMower] })).toThrow(
      AdapterLifecycleError,
    );
    expect(() => createInMemoryAdapter({ vendor: "acme", robots: [] })).not.toThrow();
  });
});

describe("InMemoryAdapter scripted telemetry", () => {
  it("emits one sample per robot per tick with strictly monotonic ts", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const samples: { robotId: string; ts: string }[] = [];
    adapter.subscribeTelemetry((sample) =>
      samples.push({ robotId: sample.robotId, ts: sample.ts }),
    );
    adapter.tick();
    adapter.tick();
    adapter.tick();
    await adapter.disconnect();
    expect(samples).toHaveLength(6); // 3 ticks × 2 robots
    expect(samples.filter((s) => s.robotId === "in-memory-mower-01").map((s) => s.ts)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:02:00.000Z",
    ]);
  });

  it("refuses to tick while disconnected", () => {
    const adapter = createInMemoryAdapter();
    expect(() => adapter.tick()).toThrow(AdapterNotConnectedError);
  });

  it("is deterministic: identical scripts produce identical streams", async () => {
    const run = async (): Promise<string> => {
      const adapter = createInMemoryAdapter();
      await adapter.connect();
      const samples: unknown[] = [];
      adapter.subscribeTelemetry((sample) => samples.push(sample));
      await adapter.sendCommand({ robotId: "in-memory-mower-01", command: "START_TASK" });
      adapter.tick();
      adapter.tick();
      await adapter.disconnect();
      return JSON.stringify(samples);
    };
    expect(await run()).toBe(await run());
  });

  it("progresses a started task and completes it after 20 ticks", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const samples: number[] = [];
    adapter.subscribeTelemetry((sample) => {
      if (sample.robotId === "in-memory-mower-01" && sample.progressPct !== undefined) {
        samples.push(sample.progressPct);
      }
    });
    await adapter.sendCommand({ robotId: "in-memory-mower-01", command: "START_TASK" });
    for (let i = 0; i < 21; i += 1) adapter.tick();
    await adapter.disconnect();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toBe(5);
    expect(samples[samples.length - 1]).toBe(100); // final tick at 100, then task completes
  });

  it("drains battery while mowing and charges while docked", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const mowerSamples: number[] = [];
    adapter.subscribeTelemetry((sample) => {
      if (sample.robotId === "in-memory-mower-01") mowerSamples.push(sample.batteryPct);
    });
    await adapter.sendCommand({ robotId: "in-memory-mower-01", command: "START_TASK" });
    adapter.tick();
    adapter.tick();
    expect(mowerSamples[0]).toBe(78); // 80 − 2
    await adapter.sendCommand({ robotId: "in-memory-mower-01", command: "DOCK_CHARGE" });
    adapter.tick();
    expect(mowerSamples[2]).toBe(84); // 76 + 8
    await adapter.disconnect();
  });
});

describe("InMemoryAdapter degrade behavior", () => {
  it("halves reported confidence while degraded and restores it on recover", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    await adapter.degrade("simulated telemetry loss");
    const degraded = await adapter.listRobots();
    expect(degraded.find((r) => r.robotId === "in-memory-mower-01")?.confidence).toBe(0.475);
    expect((await adapter.healthCheck()).state).toBe("degraded");
    adapter.recover();
    const restored = await adapter.listRobots();
    expect(restored.find((r) => r.robotId === "in-memory-mower-01")?.confidence).toBe(0.95);
    expect((await adapter.healthCheck()).state).toBe("connected");
    await adapter.disconnect();
  });
});

describe("InMemoryAdapter fault profile and transport drop", () => {
  it("covers all six fault classes with deterministic ids", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const faults: { faultId: string; type: string }[] = [];
    adapter.subscribeFaults((fault) => faults.push({ faultId: fault.faultId, type: fault.type }));
    adapter.injectFaultProfile();
    await adapter.disconnect();
    expect(faults.map((f) => f.type)).toEqual([
      "BATTERY",
      "STUCK",
      "SENSOR_DEGRADED",
      "COMMS_LOST",
      "WEATHER_HOLD",
      "MAINTENANCE_DUE",
    ]);
    expect(faults[0]?.faultId).toBe("in-memory-sim-f-000001");
  });

  it("drops and reconnects: COMMS_LOST then reconnecting → connected", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const transitions: string[] = [];
    const faults: string[] = [];
    adapter.subscribeLifecycle((event) => transitions.push(event.to));
    adapter.subscribeFaults((fault) => faults.push(fault.type));
    await adapter.dropTransport();
    expect((await adapter.healthCheck()).state).toBe("connected");
    expect(transitions).toEqual(["reconnecting", "connected"]);
    expect(faults).toEqual(["COMMS_LOST"]);
    await adapter.disconnect();
  });
});

describe("InMemoryAdapter type surface", () => {
  it("is an InMemoryAdapter instance from the factory", () => {
    const adapter = createInMemoryAdapter();
    expect(adapter).toBeInstanceOf(InMemoryAdapter);
  });
});
