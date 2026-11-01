import type { CommandPermission, FaultEvent, Robot, TelemetrySample } from "@fleetos/core-schema";

/**
 * The adapter SDK contract (spec D1): one interface per direction of flow,
 * normalizing vendor specifics into core-schema types. A vendor integration
 * implements RobotAdapter; FleetOS core never imports vendor code.
 *
 * Members are declared as function properties (not method shorthand) so
 * strictFunctionTypes applies — adapter implementations are checked
 * contravariantly, which the type-level tests rely on.
 */

/** Connection lifecycle of an adapter (spec D1: connect/reconnect/degrade). */
export const ADAPTER_LIFECYCLE_STATES = [
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "degraded",
] as const;

export type AdapterLifecycleState = (typeof ADAPTER_LIFECYCLE_STATES)[number];

/** One lifecycle transition, fanned out to subscribeLifecycle listeners. */
export interface AdapterLifecycleEvent {
  readonly from: AdapterLifecycleState;
  readonly to: AdapterLifecycleState;
  readonly detail: string;
}

/** Health snapshot surfaced by healthCheck() and, later, the operator console. */
export interface AdapterHealth {
  readonly state: AdapterLifecycleState;
  readonly detail: string;
  readonly connectedSince: string | null;
  readonly lastEventAt: string | null;
}

/** A dispatch-plane command. The adapter gates it against the robot's allow-list. */
export interface RobotCommand {
  readonly robotId: string;
  readonly command: CommandPermission;
}

/**
 * Receipt for an accepted command. Commands outside the allow-list are
 * rejected with CommandNotPermittedError before any ticket is issued.
 */
export interface CommandTicket {
  readonly ticketId: string;
  readonly robotId: string;
  readonly command: CommandPermission;
  readonly status: "accepted";
  readonly issuedAt: string;
}

export type CommandOutcome = "pending" | "succeeded" | "failed";

/** Pollable result state for a ticket (spec: result arrives via telemetry or poll). */
export interface CommandTicketState {
  readonly ticket: CommandTicket;
  readonly outcome: CommandOutcome;
  readonly settledAt: string | null;
}

/** Cancels a stream subscription; idempotent. */
export type Unsubscribe = () => void;

export interface RobotAdapter {
  /** Vendor identifier; must match the normalized Robot.vendor of its records. */
  readonly vendor: string;
  /** Vendor API surface this adapter models, e.g. "openapi-1.2". */
  readonly apiVersion: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  healthCheck: () => Promise<AdapterHealth>;
  /** Normalized capability records — schema-validated at the boundary. */
  listRobots: () => Promise<readonly Robot[]>;
  subscribeTelemetry: (cb: (sample: TelemetrySample) => void) => Unsubscribe;
  subscribeFaults: (cb: (fault: FaultEvent) => void) => Unsubscribe;
  subscribeLifecycle: (cb: (event: AdapterLifecycleEvent) => void) => Unsubscribe;
  sendCommand: (cmd: RobotCommand) => Promise<CommandTicket>;
  pollTicket: (ticketId: string) => Promise<CommandTicketState>;
}
