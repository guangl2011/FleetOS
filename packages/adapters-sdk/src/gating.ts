import { COMMAND_PERMISSIONS } from "@fleetos/core-schema";
import type { CommandPermission, Robot } from "@fleetos/core-schema";

/** Raised when a command is not in the robot's capability allow-list. */
export class CommandNotPermittedError extends Error {
  constructor(robotId: string, command: CommandPermission) {
    super(`Command "${command}" is not in the capability allow-list of robot "${robotId}"`);
    this.name = "CommandNotPermittedError";
  }
}

/** Is the robot's allow-list a superset of the commands this plan will send? */
export function isCommandPermitted(robot: Robot, command: CommandPermission): boolean {
  return robot.commands.includes(command);
}

/**
 * Gating helper — throws before dispatch, so an unpermitted command never
 * reaches the simulator or device. Every adapter gates through this.
 */
export function assertCommandPermitted(robot: Robot, command: CommandPermission): void {
  if (!isCommandPermitted(robot, command)) {
    throw new CommandNotPermittedError(robot.robotId, command);
  }
}

/** Commands the robot does NOT allow — the negative cases for contract tests. */
export function unpermittedCommands(robot: Robot): CommandPermission[] {
  return COMMAND_PERMISSIONS.filter((command) => !robot.commands.includes(command));
}
