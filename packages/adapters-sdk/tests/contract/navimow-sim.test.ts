import type { FaultEvent, TelemetrySample } from "@fleetos/core-schema";
import { expect, it } from "vitest";

import {
  defineAdapterContractTests,
  pollUntilTerminal,
} from "../../src/contract/define-adapter-contract-tests.js";
import { createNavimowMowerAdapter } from "../../src/simulators/navimow/adapter.js";
import type { NavimowMowerAdapter } from "../../src/simulators/navimow/adapter.js";

/**
 * Navimow (九号) mower simulator vs the shared contract suite (testing plan
 * §3). No per-adapter overrides — any skip would be a failing PR by
 * definition. The fixture mixes the m2 line (full command map, including
 * cloud-side SET_NO_GO_ZONE) with an older i1 unit without boundary support,
 * so the suite's gating negative case has a real target.
 */
defineAdapterContractTests({
  name: "navimow mower simulator",
  createAdapter: () => createNavimowMowerAdapter(),
  expectedVendor: "navimow",
  expectedKinds: ["mower"],
  runScriptedScenario: async (adapter) => {
    const sim = adapter as NavimowMowerAdapter;
    await sim.sendCommand({ robotId: "navimow-mower-01", command: "START_TASK" });
    sim.tick();
    sim.tick();
    sim.tick();
  },
  injectFaultProfile: async (adapter) => {
    (adapter as NavimowMowerAdapter).injectFaultProfile();
  },
  dropTransport: async (adapter) => {
    await (adapter as NavimowMowerAdapter).dropTransport();
  },
  degradeAdapter: async (adapter) => {
    (adapter as NavimowMowerAdapter).degrade("simulated telemetry loss");
  },
});

it("navimow rejects START_TASK without an RTK fix: ticket fails, SENSOR_DEGRADED surfaces", async () => {
  const sim = createNavimowMowerAdapter();
  await sim.connect();
  const faults: FaultEvent[] = [];
  sim.subscribeFaults((fault) => faults.push(fault));
  sim.setRtkStatus("navimow-mower-01", "NONE");
  const ticket = await sim.sendCommand({ robotId: "navimow-mower-01", command: "START_TASK" });
  const settled = await pollUntilTerminal(sim, ticket.ticketId);
  expect(settled.outcome).toBe("failed");
  expect(faults.some((fault) => fault.type === "SENSOR_DEGRADED")).toBe(true);
  await sim.disconnect();
});

it("navimow telemetry reports position only while the RTK fix is good", async () => {
  const sim = createNavimowMowerAdapter();
  await sim.connect();
  const samples: TelemetrySample[] = [];
  sim.subscribeTelemetry((sample) => samples.push(sample));
  await sim.sendCommand({ robotId: "navimow-mower-01", command: "START_TASK" });
  sim.tick();
  expect(samples.some((sample) => sample.robotId === "navimow-mower-01" && sample.pose)).toBe(true);
  sim.setRtkStatus("navimow-mower-01", "NONE");
  const withFixCount = samples.length;
  sim.tick();
  const afterLoss = samples
    .slice(withFixCount)
    .filter((sample) => sample.robotId === "navimow-mower-01");
  expect(afterLoss.length).toBeGreaterThan(0); // still streaming
  expect(afterLoss.every((sample) => sample.pose === undefined)).toBe(true); // position gone
  await sim.disconnect();
});
