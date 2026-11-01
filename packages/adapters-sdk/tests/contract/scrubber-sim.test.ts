import type { TelemetrySample } from "@fleetos/core-schema";
import { expect, it } from "vitest";

import { defineAdapterContractTests } from "../../src/contract/define-adapter-contract-tests.js";
import { createScrubberAdapter } from "../../src/simulators/scrubber/adapter.js";
import type { ScrubberAdapter } from "../../src/simulators/scrubber/adapter.js";

/**
 * Scrubber simulator vs the shared contract suite (testing plan §3) — the
 * next-category proof: a different robot kind behind a different vendor
 * surface, held to the identical contract. No per-adapter overrides.
 */
defineAdapterContractTests({
  name: "scrubber simulator (next-category)",
  createAdapter: () => createScrubberAdapter(),
  expectedVendor: "scrubbersim",
  expectedKinds: ["scrubber"],
  runScriptedScenario: async (adapter) => {
    const sim = adapter as ScrubberAdapter;
    await sim.sendCommand({ robotId: "scrubber-01", command: "START_TASK" });
    sim.tick();
    sim.tick();
    sim.tick();
  },
  injectFaultProfile: async (adapter) => {
    (adapter as ScrubberAdapter).injectFaultProfile();
  },
  dropTransport: async (adapter) => {
    await (adapter as ScrubberAdapter).dropTransport();
  },
  degradeAdapter: async (adapter) => {
    (adapter as ScrubberAdapter).degrade("simulated telemetry loss");
  },
});

it("scrubber suppresses pose entirely while sensors are degraded, per unit", async () => {
  const sim = createScrubberAdapter();
  await sim.connect();
  const samples: TelemetrySample[] = [];
  sim.subscribeTelemetry((sample) => samples.push(sample));
  await sim.sendCommand({ robotId: "scrubber-01", command: "START_TASK" });
  sim.tick();
  sim.tick();
  expect(
    samples.some((sample) => sample.robotId === "scrubber-01" && sample.pose),
    "healthy sensors must report pose",
  ).toBe(true);

  sim.setSensorHealth("scrubber-01", "DEGRADED");
  const beforeDegraded = samples.length;
  sim.tick();
  sim.tick();
  const scrubber01 = samples
    .slice(beforeDegraded)
    .filter((sample) => sample.robotId === "scrubber-01");
  const scrubber02 = samples
    .slice(beforeDegraded)
    .filter((sample) => sample.robotId === "scrubber-02");
  expect(scrubber01.length).toBeGreaterThan(0); // still streaming
  expect(scrubber01.every((sample) => sample.pose === undefined)).toBe(true); // pose gone
  expect(scrubber02.every((sample) => sample.pose !== undefined)).toBe(true); // healthy unit unaffected
  await sim.disconnect();
});

it("scrubber reports progress only while actively cleaning", async () => {
  const sim = createScrubberAdapter();
  await sim.connect();
  const samples: TelemetrySample[] = [];
  sim.subscribeTelemetry((sample) => samples.push(sample));
  await sim.sendCommand({ robotId: "scrubber-01", command: "START_TASK" });
  sim.tick();
  expect(
    samples.some((sample) => sample.robotId === "scrubber-01" && sample.progressPct !== undefined),
  ).toBe(true);
  await sim.sendCommand({ robotId: "scrubber-01", command: "PAUSE" });
  const beforePaused = samples.length;
  sim.tick();
  const pausedSamples = samples
    .slice(beforePaused)
    .filter((sample) => sample.robotId === "scrubber-01");
  expect(pausedSamples.length).toBeGreaterThan(0); // still streaming
  expect(pausedSamples.every((sample) => sample.progressPct === undefined)).toBe(true);
  await sim.disconnect();
});
