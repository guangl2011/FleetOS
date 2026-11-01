import type { TelemetrySample } from "@fleetos/core-schema";
import { expect, it } from "vitest";

import type { AdapterLifecycleState } from "../../src/adapter.js";
import { defineAdapterContractTests } from "../../src/contract/define-adapter-contract-tests.js";
import { createHusqvarnaMowerAdapter } from "../../src/simulators/husqvarna/adapter.js";
import type { HusqvarnaMowerAdapter } from "../../src/simulators/husqvarna/adapter.js";

/**
 * Husqvarna mower simulator vs the shared contract suite (testing plan §3).
 * No per-adapter overrides — any skip would be a failing PR by definition.
 */
defineAdapterContractTests({
  name: "husqvarna mower simulator",
  createAdapter: () => createHusqvarnaMowerAdapter(),
  expectedVendor: "husqvarna",
  expectedKinds: ["mower"],
  runScriptedScenario: async (adapter) => {
    const sim = adapter as HusqvarnaMowerAdapter;
    await sim.sendCommand({ robotId: "husqvarna-mower-01", command: "START_TASK" });
    sim.tick();
    sim.tick();
    sim.tick();
  },
  injectFaultProfile: async (adapter) => {
    (adapter as HusqvarnaMowerAdapter).injectFaultProfile();
  },
  dropTransport: async (adapter) => {
    await (adapter as HusqvarnaMowerAdapter).dropTransport();
  },
  degradeAdapter: async (adapter) => {
    (adapter as HusqvarnaMowerAdapter).degrade("simulated telemetry loss");
  },
});

it("husqvarna token expiry blanks telemetry for exactly one tick, then auto-recovers", async () => {
  const sim = createHusqvarnaMowerAdapter({ tokenTtlTicks: 2 });
  await sim.connect();
  const transitions: AdapterLifecycleState[] = [];
  sim.subscribeLifecycle((event) => transitions.push(event.to));
  const samples: TelemetrySample[] = [];
  sim.subscribeTelemetry((sample) => samples.push(sample));
  await sim.sendCommand({ robotId: "husqvarna-mower-01", command: "START_TASK" });

  sim.expireTokenNextTick();
  const beforeExpiry = samples.length;
  sim.tick(); // expiry tick: token window blanked
  expect(samples.length, "expired token must blank the telemetry window").toBe(beforeExpiry);
  sim.tick(); // next tick: token refreshed, telemetry flows again
  expect(samples.length, "refreshed token must resume telemetry").toBeGreaterThan(beforeExpiry);
  expect((await sim.healthCheck()).state, "token refresh must restore connected").toBe("connected");
  expect(transitions, "expiry must surface degraded then connected again").toContain("degraded");
  await sim.disconnect();
});

it("husqvarna telemetry reports position only while the GPS fix is good", async () => {
  const sim = createHusqvarnaMowerAdapter();
  await sim.connect();
  const samples: TelemetrySample[] = [];
  sim.subscribeTelemetry((sample) => samples.push(sample));
  await sim.sendCommand({ robotId: "husqvarna-mower-01", command: "START_TASK" });
  sim.tick();
  expect(samples.some((sample) => sample.robotId === "husqvarna-mower-01" && sample.pose)).toBe(
    true,
  );
  sim.setGpsFix("husqvarna-mower-01", "NONE");
  const withFixCount = samples.length;
  sim.tick();
  const afterLoss = samples
    .slice(withFixCount)
    .filter((sample) => sample.robotId === "husqvarna-mower-01");
  expect(afterLoss.length).toBeGreaterThan(0); // still streaming
  expect(afterLoss.every((sample) => sample.pose === undefined)).toBe(true); // position gone
  await sim.disconnect();
});
