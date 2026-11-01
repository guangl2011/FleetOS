import { describe, expect, it } from "vitest";

import { DETERMINISTIC_PREDICTOR_ID, createWorldModel } from "../src/index.js";
import { at, mowerRobot, sampleAt, scrubberRobot } from "./helpers.js";
import { ManualClock } from "@fleetos/adapters-sdk";

/**
 * The fixture mower: batteryWh 7200, nominalPowerWhPerHour 900 → 12.5%/h
 * drain; chargeHours [1.5, 4] → worst-case (90% span / 4h) = 22.5%/h charge.
 */
const MOWER_DRAIN_PCT_PER_HOUR = (900 / 7200) * 100;
const MOWER_CHARGE_PCT_PER_HOUR = 90 / 4;

describe("deterministic predictor", () => {
  it("projects battery drain from capability physics", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 80, progressPct: 10 }));

    const futures = model.predict(60);
    const projected = futures.robots.find((r) => r.robotId === "robot-mower-01");
    expect(projected?.predictedBatteryPct).toBeCloseTo(80 - MOWER_DRAIN_PCT_PER_HOUR, 10);
    expect(projected?.predictedCharging).toBe(false);
    expect(projected?.predictedProgressPct).toBe(10); // v1 carries progress
    expect(projected?.confidence).toBeCloseTo(0.95, 10);
    expect(futures.predictorId).toBe(DETERMINISTIC_PREDICTOR_ID);
    expect(futures.generatedAt).toBe(at(0));
    expect(futures.horizonMinutes).toBe(60);
  });

  it("projects charging from the worst-case charge-hours and caps at 100", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 50, charging: true }));

    const atOneHour = model.predict(60).robots[0]?.predictedBatteryPct;
    expect(atOneHour).toBeCloseTo(50 + MOWER_CHARGE_PCT_PER_HOUR, 10);

    model.ingest(sampleAt(at(60), "robot-mower-01", { batteryPct: 95, charging: true }));
    const capped = model.predict(60).robots[0]?.predictedBatteryPct;
    expect(capped).toBe(100);
  });

  it("floors battery at 0 for a starving robot", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 5 }));
    expect(model.predict(60).robots[0]?.predictedBatteryPct).toBe(0);
  });

  it("keeps null projections for robots with no observation", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot(), scrubberRobot()], clock });
    model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 80 }));
    const scrubber = model.predict(30).robots.find((r) => r.robotId === "robot-scrubber-01");
    expect(scrubber?.predictedBatteryPct).toBeNull();
    expect(scrubber?.predictedCharging).toBeNull();
    expect(scrubber?.predictedProgressPct).toBeNull();
    expect(scrubber?.confidence).toBe(0);
  });

  it("produces identical futures across runs on the same scenario (determinism)", () => {
    function run(): string {
      const clock = new ManualClock(at(0));
      const model = createWorldModel({ robots: [mowerRobot(), scrubberRobot()], clock });
      model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 80, progressPct: 10 }));
      model.ingest(sampleAt(at(30), "robot-scrubber-01", { batteryPct: 65, charging: true }));
      clock.advanceSeconds(60);
      return JSON.stringify(model.predict(45));
    }
    expect(run()).toBe(run());
  });

  it("sorts predicted robots by robotId", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({
      robots: [scrubberRobot("z-scrubber"), mowerRobot("a-mower")],
      clock,
    });
    expect(model.predict(30).robots.map((r) => r.robotId)).toEqual(["a-mower", "z-scrubber"]);
  });

  it("rejects non-positive or non-finite horizons with a typed error", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    for (const horizon of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => model.predict(horizon)).toThrowError(/horizonMinutes/);
    }
  });
});
