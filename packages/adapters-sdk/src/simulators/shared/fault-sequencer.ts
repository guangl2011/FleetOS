import type { FaultEvent, FaultSeverity, FaultType } from "@fleetos/core-schema";

/**
 * Sequences vendor-prefixed fault ids (`{vendor}-f-000001`) and builds
 * normalized FaultEvents — shared by all four simulators so fault ids stay
 * unique per adapter and identically formatted.
 */
export class FaultSequencer {
  private count = 0;

  constructor(private readonly vendor: string) {}

  nextFaultId(): string {
    this.count += 1;
    return `${this.vendor}-f-${String(this.count).padStart(6, "0")}`;
  }

  build(input: {
    robotId: string;
    ts: string;
    type: FaultType;
    severity: FaultSeverity;
    message: string;
    detail?: Record<string, string>;
  }): FaultEvent {
    return {
      faultId: this.nextFaultId(),
      robotId: input.robotId,
      ts: input.ts,
      type: input.type,
      severity: input.severity,
      message: input.message,
      ...(input.detail ? { detail: input.detail } : {}),
    };
  }
}
