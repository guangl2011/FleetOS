import { exampleRobotMower } from "@fleetos/core-schema";
import { describe, expect, it } from "vitest";

import {
  assertCommandPermitted,
  CommandNotPermittedError,
  isCommandPermitted,
  unpermittedCommands,
} from "../src/gating.js";

const mower = exampleRobotMower;

describe("command gating by capability", () => {
  it("permits every command in the allow-list", () => {
    for (const command of mower.commands) {
      expect(isCommandPermitted(mower, command)).toBe(true);
    }
  });

  it("rejects commands outside the allow-list", () => {
    expect(isCommandPermitted(mower, "SET_NO_GO_ZONE")).toBe(false);
  });

  it("throws CommandNotPermittedError naming the robot and command", () => {
    try {
      assertCommandPermitted(mower, "SET_NO_GO_ZONE");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CommandNotPermittedError);
      expect((error as Error).message).toContain("SET_NO_GO_ZONE");
      expect((error as Error).message).toContain(mower.robotId);
    }
  });

  it("reports the exact unpermitted set", () => {
    expect(unpermittedCommands(mower)).toEqual(["SET_NO_GO_ZONE"]);
  });

  it("reports no unpermitted commands for a full allow-list", () => {
    const fullAllowList = { ...mower, commands: [...mower.commands, "SET_NO_GO_ZONE" as const] };
    expect(unpermittedCommands(fullAllowList)).toEqual([]);
  });
});
