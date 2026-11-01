// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { BenchmarkReportView } from "../api/types";

import { BenchmarkView, interventionChip, onTimeChip } from "./BenchmarkView";

const passingRun: BenchmarkReportView = {
  runId: "run-1",
  createdAt: "2026-11-01T10:00:00.000Z",
  scenarioId: "demo-mixed-fleet",
  seed: 42,
  baseline: {
    onTimeCompletion: 0.72,
    interventionsPer100RobotHours: 4.2,
    energyCostUsd: 18.4,
  },
  riskAware: {
    onTimeCompletion: 0.91,
    interventionsPer100RobotHours: 3.1,
    energyCostUsd: 14.9,
  },
  deltas: {
    onTimeCompletionDeltaPp: 19,
    interventionReductionPct: 26.2,
    energyCostDeltaUsd: -3.5,
  },
};

const failingRun: BenchmarkReportView = {
  ...passingRun,
  runId: "run-2",
  baseline: { ...passingRun.baseline, interventionsPer100RobotHours: 0 },
  riskAware: { ...passingRun.riskAware, interventionsPer100RobotHours: 0 },
  deltas: { onTimeCompletionDeltaPp: 4, interventionReductionPct: null, energyCostDeltaUsd: 0.2 },
};

describe("benchmark chips", () => {
  it("pass on the docx §7 bars and fail under them", () => {
    expect(onTimeChip(19)).toMatchObject({ pass: true });
    expect(onTimeChip(14.9)).toMatchObject({ pass: false });
    expect(interventionChip(26.2)).toMatchObject({ pass: true });
    expect(interventionChip(15)).toMatchObject({ pass: false });
    expect(interventionChip(null)?.label).toContain("no interventions to reduce");
  });
});

describe("BenchmarkView", () => {
  it("renders baseline → risk-aware metrics with pass/fail delta badges", () => {
    render(<BenchmarkView runs={[passingRun]} />);
    expect(screen.getByTestId("benchmark-run-1")).toBeInTheDocument();
    expect(screen.getByText("+19.0pp vs baseline")).toBeInTheDocument();
    expect(screen.getByText("−26.2% interventions")).toBeInTheDocument();
    // The baseline → risk-aware cells render as several text nodes, so assert
    // on the row's full text instead of a single text node.
    const row = screen.getByTestId("benchmark-run-1");
    expect(row.textContent).toContain("72% → 91%");
    expect(row.textContent).toContain("$18.40 → $14.90");
  });

  it("marks runs below the bars with failing badges", () => {
    render(<BenchmarkView runs={[failingRun]} />);
    expect(screen.getByText("+4.0pp vs baseline")).toBeInTheDocument();
    expect(screen.getByText("no interventions to reduce")).toBeInTheDocument();
  });

  it("shows an empty state before any run is recorded", () => {
    render(<BenchmarkView runs={[]} />);
    expect(screen.getByText("No benchmark runs recorded yet.")).toBeInTheDocument();
  });
});
