import { WorldModelError } from "./errors.js";

/**
 * Confidence calibration metrics (testing plan §5.2). One sample pairs the
 * confidence the shadow reported at decision time with the observed outcome
 * of the thing that confidence described (e.g. "this robot stayed
 * operational through the next window"). The scheduler benchmark feeds
 * seeded scenarios through the shadow, collects samples, and reports these —
 * "the model knows what it doesn't know" is a measured claim, not an
 * adjective.
 */
export interface CalibrationSample {
  /** Predicted confidence in [0, 1]. */
  readonly predicted: number;
  /** Observed outcome: 1 = occurred, 0 = did not. */
  readonly observed: 0 | 1;
}

export interface CalibrationBin {
  /** Bin is [lower, upper) — except the last, which is closed at 1. */
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  /** Mean predicted confidence in the bin; null when empty. */
  readonly predictedMean: number | null;
  /** Observed rate in the bin; null when empty. */
  readonly observedRate: number | null;
}

export interface CalibrationReport {
  /** Brier score — mean (predicted − observed)². Null with no samples. */
  readonly brier: number | null;
  /** Expected calibration error — count-weighted |predictedMean − observedRate|. Null with no samples. */
  readonly ece: number | null;
  readonly binCount: number;
  /** Reliability bins over [0, 1], always all `binCount` of them. */
  readonly bins: readonly CalibrationBin[];
}

function assertSample(sample: CalibrationSample, index: number): void {
  if (!Number.isFinite(sample.predicted) || sample.predicted < 0 || sample.predicted > 1) {
    throw new WorldModelError(
      "CALIBRATION_SAMPLE_INVALID",
      `sample ${index}: predicted confidence must be in [0, 1], got ${sample.predicted}`,
    );
  }
  if (sample.observed !== 0 && sample.observed !== 1) {
    throw new WorldModelError(
      "CALIBRATION_SAMPLE_INVALID",
      `sample ${index}: observed outcome must be 0 or 1, got ${sample.observed}`,
    );
  }
}

/**
 * Brier score: a strict proper scoring rule — a well-calibrated predictor
 * minimizes it, and it is penalized for both discrimination and calibration.
 * Returns null for an empty set (no samples is absence, not zero).
 */
export function brierScore(samples: readonly CalibrationSample[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  let total = 0;
  for (const [index, sample] of samples.entries()) {
    assertSample(sample, index);
    total += (sample.predicted - sample.observed) ** 2;
  }
  return total / samples.length;
}

/** Bins the predicted values into `binCount` equal-width bins over [0, 1]. */
export function reliabilityBins(
  samples: readonly CalibrationSample[],
  binCount: number,
): readonly CalibrationBin[] {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new WorldModelError(
      "CALIBRATION_BIN_COUNT_INVALID",
      `binCount must be a positive integer`,
    );
  }
  for (const [index, sample] of samples.entries()) {
    assertSample(sample, index);
  }
  const sums = new Array<number>(binCount).fill(0);
  const observedSums = new Array<number>(binCount).fill(0);
  const counts = new Array<number>(binCount).fill(0);
  for (const sample of samples) {
    // p = 1 lands in the last bin, keeping every bin half-open [lower, upper).
    const binIndex = Math.min(binCount - 1, Math.floor(sample.predicted * binCount));
    sums[binIndex] = (sums[binIndex] ?? 0) + sample.predicted;
    observedSums[binIndex] = (observedSums[binIndex] ?? 0) + sample.observed;
    counts[binIndex] = (counts[binIndex] ?? 0) + 1;
  }
  return Array.from({ length: binCount }, (_, i) => {
    const count = counts[i] ?? 0;
    return {
      lower: i / binCount,
      upper: (i + 1) / binCount,
      count,
      predictedMean: count > 0 ? (sums[i] ?? 0) / count : null,
      observedRate: count > 0 ? (observedSums[i] ?? 0) / count : null,
    };
  });
}

/**
 * Expected calibration error: count-weighted mean absolute gap between
 * predicted mean and observed rate per bin — the standard operational read
 * of "does a 0.9 mean 90%?".
 */
export function expectedCalibrationError(
  samples: readonly CalibrationSample[],
  binCount = 10,
): number | null {
  if (samples.length === 0) {
    return null;
  }
  let ece = 0;
  for (const bin of reliabilityBins(samples, binCount)) {
    if (bin.count > 0 && bin.predictedMean !== null && bin.observedRate !== null) {
      ece += (bin.count / samples.length) * Math.abs(bin.predictedMean - bin.observedRate);
    }
  }
  return ece;
}

/** Both metrics plus the reliability diagram data, in one deterministic report. */
export function calibrationReport(
  samples: readonly CalibrationSample[],
  binCount = 10,
): CalibrationReport {
  return {
    brier: brierScore(samples),
    ece: expectedCalibrationError(samples, binCount),
    binCount,
    bins: reliabilityBins(samples, binCount),
  };
}
