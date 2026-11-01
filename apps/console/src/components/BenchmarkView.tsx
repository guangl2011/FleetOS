/**
 * Benchmark results — scheduler-vs-baseline comparisons with the docx §7 pass
 * bars made visible (≥15pp on-time delta, ≥20% intervention reduction). Pure
 * props; runs are recorded through the API (demo harness or benchmark CLI).
 */
import { BENCHMARK_BARS, fmtPct, fmtUsd } from "../format";
import type { BenchmarkReportView } from "../api/types";
import { Badge, EmptyState, Panel } from "./ui";

/** Pass/fail chip for the on-time delta bar (percentage points). */
export function onTimeChip(deltaPp: number) {
  const pass = deltaPp >= BENCHMARK_BARS.onTimeDeltaPp;
  return { pass, label: `${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(1)}pp vs baseline` };
}

/** Pass/fail chip for the intervention-reduction bar; null deltas show as n/a. */
export function interventionChip(reductionPct: number | null) {
  if (reductionPct === null) {
    return { pass: false, label: "no interventions to reduce" };
  }
  const pass = reductionPct >= BENCHMARK_BARS.interventionReductionPct;
  return { pass, label: `−${reductionPct.toFixed(1)}% interventions` };
}

export function BenchmarkView(props: { readonly runs: readonly BenchmarkReportView[] }) {
  return (
    <Panel
      title="Benchmark results"
      subtitle={`Pass bars (docx §7): ≥${BENCHMARK_BARS.onTimeDeltaPp}pp on-time delta, ≥${BENCHMARK_BARS.interventionReductionPct}% fewer interventions per 100 robot-hours`}
    >
      {props.runs.length === 0 ? (
        <EmptyState message="No benchmark runs recorded yet." />
      ) : (
        <table className="data-table" data-testid="benchmark-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Scenario</th>
              <th>On-time (baseline → risk-aware)</th>
              <th>On-time delta</th>
              <th>Interventions / 100h (baseline → risk-aware)</th>
              <th>Intervention delta</th>
              <th>Energy cost (baseline → risk-aware)</th>
            </tr>
          </thead>
          <tbody>
            {props.runs.map((run) => {
              const onTime = onTimeChip(run.deltas.onTimeCompletionDeltaPp);
              const interventions = interventionChip(run.deltas.interventionReductionPct);
              return (
                <tr key={run.runId} data-testid={`benchmark-${run.runId}`}>
                  <td className="mono">
                    {run.runId}
                    <span className="muted"> · seed {run.seed}</span>
                  </td>
                  <td className="mono">{run.scenarioId}</td>
                  <td>
                    {fmtPct(run.baseline.onTimeCompletion)} → {fmtPct(run.riskAware.onTimeCompletion)}
                  </td>
                  <td>
                    <Badge tone={onTime.pass ? "green" : "red"}>{onTime.label}</Badge>
                  </td>
                  <td>
                    {run.baseline.interventionsPer100RobotHours.toFixed(1)} →{" "}
                    {run.riskAware.interventionsPer100RobotHours.toFixed(1)}
                  </td>
                  <td>
                    <Badge tone={interventions.pass ? "green" : "red"}>{interventions.label}</Badge>
                  </td>
                  <td>
                    {fmtUsd(run.baseline.energyCostUsd)} → {fmtUsd(run.riskAware.energyCostUsd)} (
                    {run.deltas.energyCostDeltaUsd <= 0 ? "−" : "+"}
                    {fmtUsd(Math.abs(run.deltas.energyCostDeltaUsd))})
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
