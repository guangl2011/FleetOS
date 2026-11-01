import { exampleRobotMower } from "@fleetos/core-schema";
import type { Robot } from "@fleetos/core-schema";
import { describe, expect, it } from "vitest";

import {
  defineAdapterContractTests,
  pollUntilTerminal,
} from "../../src/contract/define-adapter-contract-tests.js";
import { createInMemoryAdapter } from "../../src/testing/in-memory-adapter.js";
import type { InMemoryAdapter } from "../../src/testing/in-memory-adapter.js";

/**
 * Self-pass: the shared contract suite (testing plan §3) run against the
 * reference in-memory adapter — the same suite every simulator adapter will
 * run. A second, customized instance proves the harness is parameterizable
 * (different vendor, single-kind fleet).
 */

defineAdapterContractTests({
  name: "in-memory reference adapter (self-pass)",
  createAdapter: () => createInMemoryAdapter(),
  expectedVendor: "in-memory-sim",
  expectedKinds: ["mower", "scrubber"],
  runScriptedScenario: async (adapter) => {
    const sim = adapter as InMemoryAdapter;
    await sim.sendCommand({ robotId: "in-memory-mower-01", command: "START_TASK" });
    sim.tick();
    sim.tick();
    sim.tick();
  },
  injectFaultProfile: async (adapter) => {
    (adapter as InMemoryAdapter).injectFaultProfile();
  },
  dropTransport: async (adapter) => {
    await (adapter as InMemoryAdapter).dropTransport();
  },
  degradeAdapter: async (adapter) => {
    (adapter as InMemoryAdapter).degrade("simulated telemetry loss");
  },
});

const customMower: Robot = {
  ...exampleRobotMower,
  vendor: "custom-sim",
  robotId: "custom-mower-01",
};

defineAdapterContractTests({
  name: "customized in-memory adapter (single-kind fleet)",
  createAdapter: () => createInMemoryAdapter({ vendor: "custom-sim", robots: [customMower] }),
  expectedVendor: "custom-sim",
  expectedKinds: ["mower"],
  runScriptedScenario: async (adapter) => {
    const sim = adapter as InMemoryAdapter;
    await sim.sendCommand({ robotId: "custom-mower-01", command: "START_TASK" });
    sim.tick();
  },
  injectFaultProfile: async (adapter) => {
    (adapter as InMemoryAdapter).injectFaultProfile();
  },
  dropTransport: async (adapter) => {
    await (adapter as InMemoryAdapter).dropTransport();
  },
  degradeAdapter: async (adapter) => {
    (adapter as InMemoryAdapter).degrade("simulated telemetry loss");
  },
});

describe("contract harness wiring", () => {
  it("exposes pollUntilTerminal for downstream consumers", async () => {
    const adapter = createInMemoryAdapter();
    await adapter.connect();
    const ticket = await adapter.sendCommand({ robotId: "in-memory-mower-01", command: "PAUSE" });
    const settled = await pollUntilTerminal(adapter, ticket.ticketId);
    expect(settled.outcome).toBe("succeeded");
    await adapter.disconnect();
  });
});
