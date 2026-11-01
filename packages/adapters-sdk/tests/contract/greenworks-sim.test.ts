import { expect, it } from "vitest";
import type { TelemetrySample } from "@fleetos/core-schema";

import { defineAdapterContractTests } from "../../src/contract/define-adapter-contract-tests.js";
import { createGreenworksMowerAdapter } from "../../src/simulators/greenworks/adapter.js";
import type { GreenworksMowerAdapter } from "../../src/simulators/greenworks/adapter.js";

/**
 * Greenworks mower simulator vs the shared contract suite (testing plan §3).
 * No per-adapter overrides — any skip would be a failing PR by definition.
 */
defineAdapterContractTests({
  name: "greenworks mower simulator",
  createAdapter: () => createGreenworksMowerAdapter(),
  expectedVendor: "greenworks",
  expectedKinds: ["mower"],
  runScriptedScenario: async (adapter) => {
    const sim = adapter as GreenworksMowerAdapter;
    await sim.sendCommand({ robotId: "greenworks-mower-01", command: "START_TASK" });
    sim.tick();
    sim.tick();
    sim.tick();
  },
  injectFaultProfile: async (adapter) => {
    (adapter as GreenworksMowerAdapter).injectFaultProfile();
  },
  dropTransport: async (adapter) => {
    await (adapter as GreenworksMowerAdapter).dropTransport();
  },
  degradeAdapter: async (adapter) => {
    (adapter as GreenworksMowerAdapter).degrade("simulated telemetry loss");
  },
});

it("greenworks telemetry reports the vendor's coarse 5%-stepped battery", async () => {
  const sim = createGreenworksMowerAdapter();
  await sim.connect();
  const samples: TelemetrySample[] = [];
  sim.subscribeTelemetry((sample) => samples.push(sample));
  await sim.sendCommand({ robotId: "greenworks-mower-01", command: "START_TASK" });
  sim.tick();
  sim.tick();
  // 80% − 2%/tick → 78, 76 internally; the vendor field floors to 5% steps.
  const forRobot = samples.filter((sample) => sample.robotId === "greenworks-mower-01");
  expect(forRobot).toHaveLength(2);
  expect(forRobot[0]?.batteryPct).toBe(75);
  expect(forRobot[1]?.batteryPct).toBe(75);
  expect(forRobot[0]?.progressPct).toBe(5);
  expect(forRobot[1]?.progressPct).toBe(10);
  await sim.disconnect();
});
