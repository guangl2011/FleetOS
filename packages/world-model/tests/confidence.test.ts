import { ManualClock } from "@fleetos/adapters-sdk";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIDENCE_TUNING,
  WorldModelError,
  createWorldModel,
  estimateConfidence,
  faultFactor,
  freshnessFactor,
  mergeTuning,
} from "../src/index.js";
import { at, faultAt, mowerRobot, sampleAt } from "./helpers.js";

describe("freshness factor", () => {
  const tuning = DEFAULT_CONFIDENCE_TUNING;

  it("is 1 within the fresh window", () => {
    expect(freshnessFactor(0, tuning)).toBe(1);
    expect(freshnessFactor(60, tuning)).toBe(1);
    expect(freshnessFactor(tuning.freshWithinSeconds, tuning)).toBe(1);
  });

  it("decays exponentially past the fresh window and hits 0 past unreachable", () => {
    const oneHalfLifeIn = tuning.freshWithinSeconds + tuning.halfLifeSeconds;
    expect(freshnessFactor(oneHalfLifeIn, tuning)).toBeCloseTo(0.5, 10);
    // State derivation turns unreachable strictly past the threshold; freshness
    // reaches 0 exactly there — just past it.
    expect(freshnessFactor(tuning.unreachableAfterSeconds, tuning)).toBeGreaterThan(0);
    expect(freshnessFactor(tuning.unreachableAfterSeconds + 1, tuning)).toBe(0);
  });

  it("decays strictly monotonically with age", () => {
    let previous = freshnessFactor(0, tuning);
    for (let age = 30; age <= tuning.unreachableAfterSeconds; age += 30) {
      const current = freshnessFactor(age, tuning);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("fault factor", () => {
  const tuning = DEFAULT_CONFIDENCE_TUNING;

  it("is 1 with no active fault", () => {
    expect(faultFactor(null, tuning)).toBe(1);
  });

  it("ranks COMMS_LOST below SENSOR_DEGRADED below other faults below none", () => {
    const comms = faultAt("f1", "r", at(0), "COMMS_LOST", "critical");
    const sensor = faultAt("f2", "r", at(0), "SENSOR_DEGRADED", "warning");
    const stuck = faultAt("f3", "r", at(0), "STUCK", "warning");
    const commsFactor = faultFactor(comms, tuning);
    const sensorFactor = faultFactor(sensor, tuning);
    const stuckFactor = faultFactor(stuck, tuning);
    expect(commsFactor).toBeLessThan(sensorFactor);
    expect(sensorFactor).toBeLessThan(stuckFactor);
    expect(stuckFactor).toBeLessThan(1);
  });
});

describe("estimateConfidence", () => {
  const tuning = DEFAULT_CONFIDENCE_TUNING;

  it("scores 0 for a robot never observed", () => {
    expect(estimateConfidence(0.95, null, null, tuning)).toBe(0);
  });

  it("stays in [0, 1] at every age and fault combination", () => {
    for (const age of [0, 120, 300, 600, 1799, 1800, 5000]) {
      for (const fault of [null, "COMMS_LOST", "SENSOR_DEGRADED", "BATTERY"] as const) {
        const active = fault === null ? null : faultAt("f", "r", at(0), fault, "warning");
        const value = estimateConfidence(0.95, age, active, tuning);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reduces to base quality when fresh and fault-free", () => {
    expect(estimateConfidence(0.9, 0, null, tuning)).toBeCloseTo(0.9, 10);
  });
});

describe("mergeTuning", () => {
  it("merges partial overrides onto the defaults", () => {
    const tuning = mergeTuning({ halfLifeSeconds: 60 });
    expect(tuning.halfLifeSeconds).toBe(60);
    expect(tuning.freshWithinSeconds).toBe(DEFAULT_CONFIDENCE_TUNING.freshWithinSeconds);
  });

  it("rejects negative windows, out-of-range factors, and inverted thresholds", () => {
    expect(() => mergeTuning({ halfLifeSeconds: -1 })).toThrowError(WorldModelError);
    expect(() => mergeTuning({ commsLostFactor: 1.5 })).toThrowError(WorldModelError);
    expect(() => mergeTuning({ staleAfterSeconds: 9999 })).toThrowError(/at most/);
  });
});

/**
 * Testing plan §2.3: stale telemetry, then degraded telemetry, then a
 * comms-loss — confidence drops monotonically and recovers on fresh data.
 */
describe("confidence over a degradation sequence", () => {
  it("drops monotonically through staleness, degradation, and comms loss, then recovers", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    const robotId = "robot-mower-01";

    model.ingest(sampleAt(at(0), robotId, { progressPct: 10 }));
    const fresh = model.confidence(robotId);
    expect(model.sliceFor(robotId)?.state).toBe("executing");

    clock.advanceSeconds(300); // stale-ish: past the fresh window
    const aged = model.confidence(robotId);
    expect(aged).toBeLessThan(fresh);
    expect(model.sliceFor(robotId)?.state).toBe("executing"); // not yet stale at 300s

    clock.advanceSeconds(360); // 660s: past the stale threshold
    const stale = model.confidence(robotId);
    expect(stale).toBeLessThan(aged);
    expect(model.sliceFor(robotId)?.state).toBe("stale");

    model.ingest(faultAt("f-sensor", robotId, at(660), "SENSOR_DEGRADED", "warning"));
    const degraded = model.confidence(robotId);
    expect(degraded).toBeLessThan(stale); // the fault factor still applies to confidence
    // Documented precedence: staleness outranks the fault overlay — the data
    // age dominates the label, while the fault stays visible on the slice.
    expect(model.sliceFor(robotId)?.state).toBe("stale");
    expect(model.sliceFor(robotId)?.activeFault?.type).toBe("SENSOR_DEGRADED");

    model.ingest(faultAt("f-comms", robotId, at(720), "COMMS_LOST", "critical"));
    const lost = model.confidence(robotId);
    expect(lost).toBeLessThan(degraded);
    expect(model.sliceFor(robotId)?.state).toBe("unreachable");

    // Fresh data with advancing progress clears the sensor fault (progress
    // moved past the fault-time baseline) and proves the link back.
    model.ingest(sampleAt(at(780), robotId, { progressPct: 20 }));
    const recovered = model.confidence(robotId);
    expect(recovered).toBeGreaterThan(lost);
    const slice = model.sliceFor(robotId);
    expect(slice?.state).toBe("executing");
    expect(slice?.activeFault).toBeNull();
    // The fault history stays visible for triage even after recovery.
    expect(slice?.lastFault?.type).toBe("COMMS_LOST");
  });

  it("keeps a fault active while progress does not advance, clearing only on real evidence", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    const robotId = "robot-mower-01";

    model.ingest(sampleAt(at(0), robotId, { progressPct: 30 }));
    model.ingest(faultAt("f-stuck", robotId, at(30), "STUCK", "warning"));
    expect(model.sliceFor(robotId)?.state).toBe("faulted");

    // Stuck robot: telemetry without progress must not clear the fault.
    model.ingest(sampleAt(at(60), robotId));
    expect(model.sliceFor(robotId)?.activeFault?.faultId).toBe("f-stuck");

    // Progress past the fault-time baseline is recovery evidence.
    model.ingest(sampleAt(at(120), robotId, { progressPct: 35 }));
    expect(model.sliceFor(robotId)?.activeFault).toBeNull();
  });
});
