/**
 * Doc-lint for docs/testing/testing-plan.md (deliverable D3).
 *
 * Two assertions, both required by the plan's §8:
 * 1. Every D3 test class named in the plan's test-class summary (§0) is present
 *    in the document as a section — the plan cannot silently drop a class.
 * 2. Every CI gate the plan references maps to a workflow file that actually
 *    exists under .github/workflows/ — the plan cannot gate on vapor.
 *
 * If you add a test class or a workflow reference to the plan, update the
 * expectations here in the same PR.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const planPath = join(repoRoot, "docs", "testing", "testing-plan.md");
const workflowsDir = join(repoRoot, ".github", "workflows");

const plan = readFileSync(planPath, "utf8");

const D3_TEST_CLASSES = [
  "Unit tests per package",
  "Adapter contract tests",
  "Deterministic benchmark scenarios",
  "Scheduler-vs-baseline comparison protocol",
  "Data-compliance checks",
  "API integration tests",
  "Manual console QA scripts",
  "Doc-lint",
  "Secret scanning",
] as const;

// Pass bars from the concept doc §7 that the comparison protocol must carry.
const REQUIRED_PASS_BARS = ["+15%", "−20%"] as const;

// Benchmark scenario presets the plan commits to at MVP acceptance.
const REQUIRED_SCENARIOS = [
  "seed-01-battery-faults",
  "seed-02-stuck-and-sensor",
  "seed-03-comms-degradation",
  "seed-04-tariff-and-noise",
] as const;

describe("testing-plan doc-lint", () => {
  it("exists", () => {
    expect(plan.length).toBeGreaterThan(0);
  });

  it.each(D3_TEST_CLASSES)("names every D3 test class as a row: %s", (testClass) => {
    expect(plan.includes(testClass)).toBe(true);
  });

  it.each(REQUIRED_PASS_BARS)("carries the concept-doc pass bar: %s", (bar) => {
    expect(plan.includes(bar)).toBe(true);
  });

  it.each(REQUIRED_SCENARIOS)("names the benchmark scenario preset: %s", (scenario) => {
    expect(plan.includes(scenario)).toBe(true);
  });

  it("has a section for each top-level D3 test class", () => {
    const headings = plan
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.replace(/^## /, ""));
    for (const required of [
      "Adapter contract tests",
      "Deterministic benchmark scenarios",
      "Scheduler-vs-baseline comparison protocol",
      "Data-compliance checks",
      "Manual console QA scripts",
    ]) {
      expect(headings.some((h) => h.toLowerCase().includes(required.toLowerCase()))).toBe(true);
    }
  });

  it("references only workflow files that exist", () => {
    const referenced = [...plan.matchAll(/\.github\/workflows\/([a-zA-Z0-9._-]+\.ya?ml)/g)].map(
      (m) => m[1],
    );
    expect(referenced.length).toBeGreaterThan(0);
    const existing = new Set(readdirSync(workflowsDir));
    for (const file of referenced) {
      expect(existing, `workflow file missing: ${file}`).toContain(file);
    }
  });

  it("gates test classes on a real workflow (quality job) rather than a fictional one", () => {
    expect(plan.includes(".github/workflows/ci.yml")).toBe(true);
    expect(readdirSync(workflowsDir)).toContain("ci.yml");
  });
});
