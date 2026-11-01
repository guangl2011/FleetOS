import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { benchmarkScenarios } from "./scenarios.js";
import { runBenchmark, summarizeReport } from "./report.js";
import type { SimulationScenario } from "../runtime.js";

/**
 * The benchmark CLI (spec D1, testing plan §4): runs the seeded scenario set
 * against both schedulers, writes the JSON report + markdown summary into
 * `bench/reports/`, and exits nonzero when the docx §7 pass bars are missed —
 * CI's benchmark step is the enforcement point, the report is the artifact.
 *
 * Usage: tsx src/bench/cli.ts [--scenario=<id>] [--out=<dir>]
 */

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const scenarioFlag = args.find((arg) => arg.startsWith("--scenario="));
const scenarioId = scenarioFlag === undefined ? null : (scenarioFlag.split("=")[1] ?? null);

const outFlag = args.find((arg) => arg.startsWith("--out="));
const outDir = resolve(here, "..", "..", "bench", "reports");

let scenarios: readonly SimulationScenario[];
if (scenarioId === null) {
  scenarios = benchmarkScenarios();
} else {
  const found = benchmarkScenarios().filter((scenario) => scenario.scenarioId === scenarioId);
  if (found.length === 0) {
    console.error(
      `unknown scenario "${scenarioId}"; known: ${benchmarkScenarios()
        .map((s) => s.scenarioId)
        .join(", ")}`,
    );
    process.exit(2);
  }
  scenarios = found;
}

const report = runBenchmark(scenarios);
const json = JSON.stringify(report, null, 2);
const markdown = summarizeReport(report);

const target = outFlag === undefined ? outDir : resolve(process.cwd(), outFlag);
mkdirSync(target, { recursive: true });
const jsonPath = resolve(target, "benchmark-report.json");
const mdPath = resolve(target, "benchmark-report.md");
writeFileSync(jsonPath, json + "\n");
writeFileSync(mdPath, markdown);

console.log(markdown);
console.log(`report written: ${jsonPath}`);

process.exit(report.passed ? 0 : 1);
