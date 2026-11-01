import type { FaultEvent, TelemetrySample } from "@fleetos/core-schema";
import { ManualClock } from "@fleetos/adapters-sdk";
import { describe, expect, it } from "vitest";

import type { CalibrationSample } from "../src/index.js";
import { brierScore, calibrationReport, createWorldModel } from "../src/index.js";
import { at, faultAt, mowerRobot, sampleAt } from "./helpers.js";

/**
 * Testing plan §2.4 — the MVP calibration scenario. Two fixture robots on a
 * one-minute telemetry cadence, direct-ingested (the same events a simulator
 * subscription would deliver):
 * - `robot-reliable` runs its task cleanly for the whole window;
 * - `robot-flaky` hits a scripted STUCK (3.5→8 min), SENSOR_DEGRADED
 *   (10.5→11 min), and COMMS_LOST (15.5→16 min).
 *
 * Pairing rule: predicted_k = the model's confidence at checkpoint k;
 * observed_k = 1 iff no fault was active during (k, k+1) minutes (checked at
 * the window midpoint — faults start and clear at half-minute/minute marks).
 * A well-calibrated model scores LOW on Brier and ECE here; the assertion
 * bars below are the recorded bar the scheduler benchmark enforces in CI.
 */
const CHECKPOINTS = 22; // minutes 0..21
const FLAKY = "robot-flaky";
const RELIABLE = "robot-reliable";

/** Fault script: onset minutes with the checkpoint whose ingest clears them. */
const FLAKY_FAULTS: ReadonlyArray<{
  readonly onsetMinute: number;
  readonly fault: FaultEvent;
  readonly clearsAtCheckpoint: number;
}> = [
  {
    onsetMinute: 3.5,
    fault: faultAt("f-stuck", FLAKY, at(210), "STUCK", "warning"),
    clearsAtCheckpoint: 8,
  },
  {
    onsetMinute: 10.5,
    fault: faultAt("f-sensor", FLAKY, at(630), "SENSOR_DEGRADED", "warning"),
    clearsAtCheckpoint: 11,
  },
  {
    onsetMinute: 15.5,
    fault: faultAt("f-comms", FLAKY, at(930), "COMMS_LOST", "critical"),
    clearsAtCheckpoint: 16,
  },
];

/** The flaky robot's telemetry: progress stops while STUCK is active. */
function flakyOverrides(k: number): Partial<Pick<TelemetrySample, "batteryPct" | "progressPct">> {
  if (k >= 4 && k <= 7) {
    return { batteryPct: 80 }; // stuck: no progress evidence
  }
  return { batteryPct: 80, progressPct: 5 * k };
}

function isFaultActiveAt(minute: number): boolean {
  return FLAKY_FAULTS.some(
    ({ onsetMinute, clearsAtCheckpoint }) => minute >= onsetMinute && minute < clearsAtCheckpoint,
  );
}

function zipSamples(
  predictions: readonly number[],
  outcomes: readonly (0 | 1)[],
): readonly CalibrationSample[] {
  if (predictions.length !== outcomes.length) {
    throw new Error("calibration pairing: predictions and outcomes must have equal length");
  }
  return predictions.map((predicted, index) => {
    const observed = outcomes[index];
    if (observed === undefined) {
      throw new Error(`calibration pairing: outcome at index ${index} is missing`);
    }
    return { predicted, observed };
  });
}

/** Null means "no samples" — an empty report is a bug here, surface it as one. */
function unwrap(value: number | null, label: string): number {
  if (value === null) {
    throw new Error(`${label} was null — the calibration report has no samples`);
  }
  return value;
}

function runCalibrationScenario(): {
  readonly flaky: readonly CalibrationSample[];
  readonly reliable: readonly CalibrationSample[];
} {
  const clock = new ManualClock(at(0));
  const model = createWorldModel({ robots: [mowerRobot(FLAKY), mowerRobot(RELIABLE)], clock });

  const predictedFlaky: number[] = [];
  const predictedReliable: number[] = [];
  const observedFlaky: (0 | 1)[] = [];
  const observedReliable: (0 | 1)[] = [];

  for (let k = 0; k < CHECKPOINTS; k++) {
    if (k > 0) {
      clock.advanceSeconds(60);
    }
    model.ingest(sampleAt(at(k * 60), FLAKY, flakyOverrides(k)));
    model.ingest(sampleAt(at(k * 60), RELIABLE, { batteryPct: 90, progressPct: 3 * k }));

    predictedFlaky.push(model.confidence(FLAKY));
    predictedReliable.push(model.confidence(RELIABLE));
    observedFlaky.push(isFaultActiveAt(k + 0.5) ? 0 : 1);
    observedReliable.push(1);

    for (const { onsetMinute, fault } of FLAKY_FAULTS) {
      if (onsetMinute === k + 0.5) {
        model.ingest(fault);
      }
    }

    // The shadow's slice state tracked the script at every checkpoint.
    const state = model.sliceFor(FLAKY)?.state;
    if (k >= 3 && k <= 7) {
      expect(state).toBe("faulted"); // STUCK injected at k=3.5, cleared at k=8
    } else if (k === 10) {
      expect(state).toBe("degraded"); // SENSOR_DEGRADED injected at k=10.5
    } else if (k >= 15 && k <= 16) {
      // COMMS_LOST at 15.5 → unreachable; the k=16 sample clears it → executing.
      expect(state).toBe(k === 15 ? "unreachable" : "executing");
    } else {
      expect(state).toBe("executing");
    }
  }

  return {
    flaky: zipSamples(predictedFlaky, observedFlaky),
    reliable: zipSamples(predictedReliable, observedReliable),
  };
}

describe("calibration metrics on the seeded scenario", () => {
  it("scores the shadow under the recorded Brier/ECE bar and discriminates a miscalibrated predictor", () => {
    const { flaky, reliable } = runCalibrationScenario();

    const brierFlaky = unwrap(brierScore(flaky), "brier (flaky)");
    const brierReliable = unwrap(brierScore(reliable), "brier (reliable)");
    const combined = calibrationReport([...flaky, ...reliable]);

    // Recorded bar (testing plan §2.4): combined Brier and ECE ≤ 0.25 on the
    // seeded scenario. The shadow's confidence dips exactly while faults are
    // active, so measured values land far inside the bar.
    expect(unwrap(combined.brier, "combined brier")).toBeLessThanOrEqual(0.25);
    expect(unwrap(combined.ece, "combined ece")).toBeLessThanOrEqual(0.25);

    // The metrics discriminate: the fault-prone robot is measurably worse
    // calibrated than the reliable one...
    expect(brierFlaky).toBeGreaterThan(brierReliable);
    // ...and a miscalibrated constant-0.99 predictor fails the same bar.
    const control = zipSamples(
      new Array<number>(CHECKPOINTS).fill(0.99),
      flaky.map((s) => s.observed),
    );
    expect(unwrap(brierScore(control), "brier (control)")).toBeGreaterThan(0.25);
  });

  it("computes per-bin calibration and scores exact predictions as perfect", () => {
    const perfect = calibrationReport([
      { predicted: 1, observed: 1 },
      { predicted: 0, observed: 0 },
      { predicted: 1, observed: 1 },
      { predicted: 1, observed: 1 },
    ]);
    expect(unwrap(perfect.brier, "perfect brier")).toBe(0);
    expect(unwrap(perfect.ece, "perfect ece")).toBe(0);

    // Four predictions of 0.9, three of which held: one bin, Brier 0.21,
    // ECE 0.15 — both metrics penalize the overconfidence.
    const report = calibrationReport([
      { predicted: 0.9, observed: 1 },
      { predicted: 0.9, observed: 1 },
      { predicted: 0.9, observed: 1 },
      { predicted: 0.9, observed: 0 },
    ]);
    expect(report.bins).toHaveLength(10);
    const bin = report.bins[9];
    expect(bin?.lower).toBeCloseTo(0.9, 10);
    expect(bin?.upper).toBe(1);
    expect(bin?.count).toBe(4);
    expect(bin?.predictedMean).toBeCloseTo(0.9, 10);
    expect(bin?.observedRate).toBeCloseTo(0.75, 10);
    expect(unwrap(report.brier, "overconfident brier")).toBeCloseTo(0.21, 10);
    expect(unwrap(report.ece, "overconfident ece")).toBeCloseTo(0.15, 10);
  });

  it("returns null (not zero) for an empty sample set and rejects out-of-range samples", () => {
    expect(brierScore([])).toBeNull();
    expect(() => brierScore([{ predicted: 1.5, observed: 1 }])).toThrowError(
      /predicted confidence must be in \[0, 1\]/,
    );
  });
});
