import type { FaultEvent, TelemetrySample } from "@fleetos/core-schema";
import { describe, expect, it } from "vitest";

import type {
  ConnectivityDrop,
  ScheduledFault,
} from "../../src/simulators/shared/fault-schedule.js";
import { createGreenworksMowerAdapter } from "../../src/simulators/greenworks/adapter.js";
import { createHusqvarnaMowerAdapter } from "../../src/simulators/husqvarna/adapter.js";
import { createNavimowMowerAdapter } from "../../src/simulators/navimow/adapter.js";
import { createScrubberAdapter } from "../../src/simulators/scrubber/adapter.js";

/**
 * Seeded-scenario determinism (testing plan §3, acceptance criterion): the
 * same seed on a fresh adapter must produce the same scheduled plan, the
 * same fault event sequence, and the same telemetry profile — tick for
 * tick — across every simulator. The connectivity-degradation scenario runs
 * identically on all four adapters (different vendor surfaces, same
 * normalized observables).
 */

/** Structural view of the simulator driver surface every vendor exposes. */
interface ScenarioAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeFaults(cb: (f: FaultEvent) => void): void;
  subscribeTelemetry(cb: (s: TelemetrySample) => void): void;
  armFaultScenario(seed: number, eventCount?: number): readonly ScheduledFault[];
  armConnectivityScenario(seed: number): readonly ConnectivityDrop[];
  tick(): void;
}

interface VendorCase {
  readonly label: string;
  readonly create: () => ScenarioAdapter;
}

const VENDORS: readonly VendorCase[] = [
  {
    label: "greenworks",
    create: () => createGreenworksMowerAdapter() as ScenarioAdapter,
  },
  {
    label: "navimow",
    create: () => createNavimowMowerAdapter() as ScenarioAdapter,
  },
  {
    label: "husqvarna",
    create: () => createHusqvarnaMowerAdapter() as ScenarioAdapter,
  },
  {
    label: "scrubber",
    create: () => createScrubberAdapter() as ScenarioAdapter,
  },
];

const FAULT_TICKS = 12;
const CONNECTIVITY_TICKS = 14;

/** Normalized-fault fields stable across runs (ids and vendor codes included via message/type). */
type FaultRecord = Pick<FaultEvent, "robotId" | "type" | "severity" | "message">;

async function runFaultScenario(
  create: () => ScenarioAdapter,
  seed: number,
): Promise<{ faults: FaultRecord[] }> {
  const adapter = create();
  await adapter.connect();
  const faults: FaultRecord[] = [];
  adapter.subscribeFaults((f) =>
    faults.push({ robotId: f.robotId, type: f.type, severity: f.severity, message: f.message }),
  );
  adapter.armFaultScenario(seed);
  for (let i = 0; i < FAULT_TICKS; i += 1) {
    adapter.tick();
  }
  await adapter.disconnect();
  return { faults };
}

async function runConnectivityScenario(
  create: () => ScenarioAdapter,
  seed: number,
): Promise<{ faults: FaultRecord[]; samplesPerTick: number[] }> {
  const adapter = create();
  await adapter.connect();
  const faults: FaultRecord[] = [];
  const samplesPerTick: number[] = [];
  let perTickSamples = 0;
  adapter.subscribeFaults((f) =>
    faults.push({ robotId: f.robotId, type: f.type, severity: f.severity, message: f.message }),
  );
  adapter.subscribeTelemetry(() => {
    perTickSamples += 1;
  });
  adapter.armConnectivityScenario(seed);
  for (let i = 0; i < CONNECTIVITY_TICKS; i += 1) {
    perTickSamples = 0;
    adapter.tick();
    samplesPerTick.push(perTickSamples);
  }
  await adapter.disconnect();
  return { faults, samplesPerTick };
}

describe("seeded fault scenarios reproduce deterministically", () => {
  for (const vendor of VENDORS) {
    it(`${vendor.label}: same seed → identical fault plan and event sequence`, async () => {
      const planA = vendor.create().armFaultScenario(42);
      const planB = vendor.create().armFaultScenario(42);
      expect(planA).toEqual(planB);

      const runA = await runFaultScenario(vendor.create, 42);
      const runB = await runFaultScenario(vendor.create, 42);
      expect(runA.faults).toEqual(runB.faults);
      expect(runA.faults.length).toBeGreaterThan(0);
    });

    it(`${vendor.label}: different seed → different fault plan`, () => {
      const planA = vendor.create().armFaultScenario(42);
      const planB = vendor.create().armFaultScenario(7);
      expect(planA).not.toEqual(planB);
    });
  }
});

describe("connectivity-degradation scenario is deterministic and observably degraded", () => {
  for (const vendor of VENDORS) {
    it(`${vendor.label}: same seed → identical drop plan, faults, and telemetry profile`, async () => {
      const planA = vendor.create().armConnectivityScenario(42);
      const planB = vendor.create().armConnectivityScenario(42);
      expect(planA).toEqual(planB);

      const runA = await runConnectivityScenario(vendor.create, 42);
      const runB = await runConnectivityScenario(vendor.create, 42);
      expect(runA.faults).toEqual(runB.faults);
      expect(runA.samplesPerTick).toEqual(runB.samplesPerTick);
    });

    it(`${vendor.label}: degradation actually blanks telemetry windows and raises COMMS_LOST`, async () => {
      const run = await runConnectivityScenario(vendor.create, 42);
      expect(run.faults.some((f) => f.type === "COMMS_LOST")).toBe(true);
      expect(run.samplesPerTick.some((count) => count === 0)).toBe(true);
    });
  }
});
