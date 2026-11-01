import { describe, expect, it } from "vitest";

import { classifyFault, DEFAULT_CLASSIFICATION_POLICY, maxSeverity } from "../src/classify.js";
import { faultEvent } from "./builders.js";

describe("classifyFault", () => {
  it("opens an exception and holds the task for a BATTERY fault", () => {
    const classification = classifyFault(faultEvent());
    expect(classification.severity).toBe("critical");
    expect(classification.opensException).toBe(true);
    expect(classification.holdsTask).toBe(true);
    expect(classification.marksDegraded).toBe(false);
    expect(classification.clearsOnTelemetry).toBe(false);
    expect(classification.suggestedRecovery).toBeNull();
  });

  it("keeps info-level weather holds out of HELD but still surfaces them", () => {
    const classification = classifyFault(
      faultEvent({ type: "WEATHER_HOLD", severity: "info", message: "rain delay" }),
    );
    expect(classification.opensException).toBe(true);
    expect(classification.holdsTask).toBe(false);
  });

  it("marks COMMS_LOST as degraded and telemetry-clearable", () => {
    const classification = classifyFault(
      faultEvent({ type: "COMMS_LOST", severity: "critical", message: "uplink lost" }),
    );
    expect(classification.marksDegraded).toBe(true);
    expect(classification.clearsOnTelemetry).toBe(true);
    expect(classification.holdsTask).toBe(true);
  });

  it("escalates severity and records the recovery a device-agent diagnosis suggests", () => {
    const classification = classifyFault(
      faultEvent({ type: "MAINTENANCE_DUE", severity: "info" }),
      {
        diagnosis: {
          diagnosisId: "diag-1",
          faultId: "fault-robot-mower-01-BATTERY-1",
          robotId: "robot-mower-01",
          ts: "2026-11-02T08:00:00.000Z",
          severity: "critical",
          summary: "service overdue and blade failing",
          suggestedRecovery: { kind: "reassign", rationale: "move the task" },
          selfClearing: false,
        },
      },
    );
    expect(classification.severity).toBe("critical");
    expect(classification.suggestedRecovery).toBe("reassign");
  });

  it("does not escalate when the diagnosis severity is lower", () => {
    const classification = classifyFault(faultEvent({ severity: "critical" }), {
      diagnosis: {
        diagnosisId: "diag-2",
        faultId: "fault-robot-mower-01-BATTERY-1",
        robotId: "robot-mower-01",
        ts: "2026-11-02T08:00:00.000Z",
        severity: "info",
        summary: "transient dip",
        suggestedRecovery: { kind: "resume", rationale: "ride it out" },
        selfClearing: true,
      },
    });
    expect(classification.severity).toBe("critical");
    expect(classification.suggestedRecovery).toBe("resume");
  });

  it("honors a custom policy that declines exceptions", () => {
    const classification = classifyFault(faultEvent(), {
      policy: { ...DEFAULT_CLASSIFICATION_POLICY, exceptionFaults: new Set() },
    });
    expect(classification.opensException).toBe(false);
    expect(classification.holdsTask).toBe(true);
  });
});

describe("maxSeverity", () => {
  it("returns the higher-severity label", () => {
    expect(maxSeverity("info", "warning")).toBe("warning");
    expect(maxSeverity("critical", "warning")).toBe("critical");
    expect(maxSeverity("info", "info")).toBe("info");
  });
});
