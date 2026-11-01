import { describe, expect, it } from "vitest";

import { createDegradedModeTracker } from "../src/degraded.js";
import { faultEvent, telemetrySample, T0 } from "./builders.js";

const COMMS_LOST = (overrides = {}) =>
  faultEvent({ type: "COMMS_LOST", message: "vendor uplink lost", ...overrides });

describe("createDegradedModeTracker", () => {
  it("is a no-op for faults that do not lose the link", () => {
    const tracker = createDegradedModeTracker();
    tracker.markDegraded("robot-mower-01", faultEvent({ type: "BATTERY" }));
    expect(tracker.isDegraded("robot-mower-01")).toBe(false);
    expect(tracker.healthOf("robot-mower-01")).not.toBe("degraded");
    expect(tracker.admitTelemetry(telemetrySample())).toBe(true);
  });

  it("marks DEGRADED on COMMS_LOST and excludes that robot's telemetry", () => {
    const tracker = createDegradedModeTracker();
    tracker.markDegraded("robot-mower-01", COMMS_LOST());
    expect(tracker.isDegraded("robot-mower-01")).toBe(true);
    expect(tracker.healthOf("robot-mower-01")).toBe("degraded");
    expect(tracker.degradedRobots()).toEqual(new Set(["robot-mower-01"]));
    // While degraded, no sample from this robot feeds optimization.
    expect(tracker.admitTelemetry(telemetrySample())).toBe(false);
    // A different robot is unaffected.
    expect(tracker.admitTelemetry(telemetrySample({ robotId: "robot-mower-02" }))).toBe(true);
  });

  it("restores the link only on a sample strictly after the fault", () => {
    const tracker = createDegradedModeTracker();
    tracker.markDegraded("robot-mower-01", COMMS_LOST());
    // Same-instant replay is stale evidence, not proof of recovery.
    expect(tracker.recordTelemetry(telemetrySample({ ts: T0 }))).toBe(false);
    expect(tracker.isDegraded("robot-mower-01")).toBe(true);
    // A later sample proves the link back.
    expect(tracker.recordTelemetry(telemetrySample({ ts: "2026-11-02T08:01:00.000Z" }))).toBe(true);
    expect(tracker.healthOf("robot-mower-01")).toBe("healthy");
    expect(tracker.admitTelemetry(telemetrySample())).toBe(true);
  });

  it("keeps the newest fault when a robot loses the link twice", () => {
    const tracker = createDegradedModeTracker();
    tracker.markDegraded("robot-mower-01", COMMS_LOST());
    expect(tracker.recordTelemetry(telemetrySample({ ts: "2026-11-02T08:01:00.000Z" }))).toBe(true);
    tracker.markDegraded(
      "robot-mower-01",
      COMMS_LOST({ faultId: "fault-2", ts: "2026-11-02T08:05:00.000Z" }),
    );
    expect(tracker.isDegraded("robot-mower-01")).toBe(true);
    // The newer fault governs: a sample between the two losses is stale again.
    expect(tracker.recordTelemetry(telemetrySample({ ts: "2026-11-02T08:02:00.000Z" }))).toBe(
      false,
    );
    expect(tracker.recordTelemetry(telemetrySample({ ts: "2026-11-02T08:06:00.000Z" }))).toBe(true);
  });
});
