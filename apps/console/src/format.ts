/** Pure display formatting helpers — no state, no IO. */

export function fmtClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}-${day} ${fmtClock(iso)}Z`;
}

export function fmtPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function fmtUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export type Tone = "green" | "amber" | "red" | "blue" | "gray" | "violet";

export function healthTone(health: string): Tone {
  if (health === "healthy") {
    return "green";
  }
  if (health === "degraded") {
    return "red";
  }
  return "gray";
}

export function severityTone(severity: string): Tone {
  if (severity === "critical") {
    return "red";
  }
  if (severity === "warning") {
    return "amber";
  }
  return "blue";
}

export function fccTone(status: string): Tone {
  if (status === "authorized") {
    return "green";
  }
  if (status === "waived-update-window") {
    return "amber";
  }
  return "red";
}

/** The docx §7 pass bars — shared by the benchmark view and its tests. */
export const BENCHMARK_BARS = { onTimeDeltaPp: 15, interventionReductionPct: 20 } as const;
