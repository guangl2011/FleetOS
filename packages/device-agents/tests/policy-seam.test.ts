import { ManualClock } from "@fleetos/adapters-sdk";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DETERMINISTIC_POLICY_ID,
  createDeviceAgent,
  createInMemoryAuditTrail,
} from "../src/index.js";
import type { AgentPolicy, DeviceAgent } from "../src/index.js";

import { T0, envelope, faultEvent, mowerRobot, shadowSlice } from "./builders.js";

/**
 * The policy seam (spec D4 claim 6): consumers see DeviceAgent regardless of
 * which policy sits behind it. The MVP ships deterministic-v1; a Phase I LLM
 * reasoner swaps in through the same interface — pinned here at both the
 * runtime and type level (checked by `pnpm typecheck`), mirroring the
 * world-model predictor seam test.
 */
describe("policy seam", () => {
  it("defaults to the deterministic policy", () => {
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: createInMemoryAuditTrail(),
      clock: new ManualClock(T0),
    });
    expect(agent.policy.id).toBe(DETERMINISTIC_POLICY_ID);
    expectTypeOf(agent).toEqualTypeOf<DeviceAgent>();
  });

  it("accepts a Phase I reasoner policy without changing consumer types", () => {
    const reasoner: AgentPolicy = {
      id: "llm-reasoner-stub-v0",
      diagnose: ({ fault, robot, envelope }) => ({
        faultId: fault.faultId,
        robotId: fault.robotId,
        severity: fault.severity,
        summary: `stub reasoner for ${robot.model} / ${envelope?.taskId ?? "no task"}`,
        suggestedRecovery: { kind: "human-service", rationale: "stub judgment" },
        selfClearing: false,
      }),
      proposeReplan: () => null,
    };
    const agent = createDeviceAgent({
      robot: mowerRobot(),
      audit: createInMemoryAuditTrail(),
      clock: new ManualClock(T0),
      policy: reasoner,
    });
    expectTypeOf(agent).toEqualTypeOf<DeviceAgent>(); // the consumer shape did not move
    expect(agent.policy.id).toBe("llm-reasoner-stub-v0");

    // The swapped policy's judgment still flows through the agent's
    // validation boundary — the policy proposes, the agent audits.
    agent.observe(shadowSlice(), envelope(), []);
    const diagnosis = agent.reportFault(
      faultEvent({ type: "STUCK", severity: "critical", faultId: "fault-stub-1" }),
    );
    expect(diagnosis.summary).toContain("stub reasoner");
    expect(diagnosis.diagnosisId).toBe("diag-fault-stub-1"); // identity stays the agent's
  });
});
