import { describe, expect, it } from "vitest";

import { runBenchmark, summarizeReport } from "../src/bench/report.js";
import {
  benchmarkScenarios,
  coreTariffPack,
  peakTariffPack,
  tariffShiftScenario,
} from "../src/bench/scenarios.js";
import type { ExternalConstraintPack } from "@fleetos/core-schema";
import {
  planSchedule,
  ruleBasedBaseline,
  runSimulation,
  type RunMetrics,
  type SimulationScenario,
} from "../src/index.js";

// The full four-scenario suite runs both schedulers per scenario; each sim is
// a deterministic ~1s run, so the suite-level tests get a generous budget.
const SUITE_TIMEOUT_MS = 120_000;

describe("scheduler benchmark (docx §7 pass bars)", () => {
  it(
    "clears both aggregate bars over the scenario set",
    () => {
      const report = runBenchmark(benchmarkScenarios());
      expect(report.aggregate.onTimeDeltaPct).toBeGreaterThanOrEqual(15);
      expect(report.aggregate.interventionsReductionPct).toBeGreaterThanOrEqual(20);
      expect(report.passed).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "feeds both schedulers identical scenarios and reproduces metrics exactly",
    () => {
      const first = runBenchmark(benchmarkScenarios());
      const second = runBenchmark(benchmarkScenarios());
      for (const [a, b] of first.scenarios.map((s, i) => [s, second.scenarios[i]!] as const)) {
        // Same world for both schedulers: identical task counts per scenario.
        expect(a.baseline.tasksTotal).toBe(a.riskAware.tasksTotal);
        // Determinism: the second run of the same seeded scenario is identical.
        expect(b).toEqual(a);
      }
      expect(second.aggregate).toEqual(first.aggregate);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "records zero mowing inside the noise-ordinance hard window for both schedulers",
    () => {
      const report = runBenchmark(benchmarkScenarios());
      const noise = report.scenarios.find((c) => c.scenarioId === "noise-ordinance");
      expect(noise).toBeDefined();
      expect(noise!.baseline.hardWindowViolations).toBe(0);
      expect(noise!.riskAware.hardWindowViolations).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "peak-tariff pack shifts the planner's charging off-peak without losing service",
    () => {
      // Same scenario, same planner, only the tariff pack differs — this
      // isolates the pack's causal effect on energy behavior.
      const runWith = (pack: ExternalConstraintPack): RunMetrics =>
        runSimulation(
          { ...tariffShiftScenario(), packs: [pack] } satisfies SimulationScenario,
          planSchedule,
        );
      const coreRun = runWith(coreTariffPack());
      const peakRun = runWith(peakTariffPack());

      const chargingKwh = (m: RunMetrics): number =>
        m.chargingIntervals.reduce((sum, c) => sum + c.kwh, 0);
      // Service holds under both tariffs.
      expect(coreRun.onTimeCompletion).toBe(1);
      expect(peakRun.onTimeCompletion).toBe(1);
      expect(peakRun.hardWindowViolations).toBe(0);
      // The peak pack makes the planner reshape charging: measured 9.5 → 2.0 kWh
      // (~79% less). The assertion leaves headroom for small retunes.
      expect(chargingKwh(peakRun)).toBeLessThanOrEqual(chargingKwh(coreRun) * 0.5);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "emits a summary report naming every scenario and a PASS verdict",
    () => {
      const report = runBenchmark(benchmarkScenarios());
      const summary = summarizeReport(report);
      for (const scenario of benchmarkScenarios()) {
        expect(summary).toContain(scenario.scenarioId);
      }
      expect(summary).toContain("**Result: PASS**");
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "baseline never dispatches into the noise hard window either",
    () => {
      // The rule-based baseline runs the same runtime feasibility gates; this
      // pins the invariant on the baseline side explicitly.
      const noise = benchmarkScenarios().find((s) => s.scenarioId === "noise-ordinance");
      expect(noise).toBeDefined();
      const metrics = runSimulation(noise!, ruleBasedBaseline);
      expect(metrics.hardWindowViolations).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );
});
