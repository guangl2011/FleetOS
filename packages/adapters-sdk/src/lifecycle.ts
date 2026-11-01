import { FaultEventSchema, RobotSchema, TelemetrySampleSchema } from "@fleetos/core-schema";
import type { FaultEvent, Robot, TelemetrySample } from "@fleetos/core-schema";
import type { z } from "zod";

import type {
  AdapterHealth,
  AdapterLifecycleEvent,
  AdapterLifecycleState,
  CommandTicket,
  CommandTicketState,
  RobotAdapter,
  RobotCommand,
  Unsubscribe,
} from "./adapter.js";
import type { Clock } from "./clock.js";
import { assertCommandPermitted } from "./gating.js";

/** A record crossed the adapter boundary without matching its core-schema contract. */
export class NormalizationError extends Error {
  constructor(context: string, issues: string) {
    super(`${context} produced a record that violates the core-schema contract: ${issues}`);
    this.name = "NormalizationError";
  }
}

export class AdapterLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterLifecycleError";
  }
}

export class AdapterNotConnectedError extends Error {
  constructor(operation: string, state: AdapterLifecycleState) {
    super(`${operation} requires a connected adapter, but the adapter is "${state}"`);
    this.name = "AdapterNotConnectedError";
  }
}

export class UnknownRobotError extends Error {
  constructor(vendor: string, robotId: string) {
    super(`Adapter "${vendor}" has no robot "${robotId}"`);
    this.name = "UnknownRobotError";
  }
}

export class UnknownTicketError extends Error {
  constructor(ticketId: string) {
    super(`No command ticket "${ticketId}" was issued by this adapter`);
    this.name = "UnknownTicketError";
  }
}

/** Validate a vendor-derived record at the normalization boundary; never swallow. */
function requireValid<S extends z.ZodType>(
  schema: S,
  value: unknown,
  context: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new NormalizationError(context, result.error.message);
  }
  return result.data;
}

type TelemetryListener = (sample: TelemetrySample) => void;
type FaultListener = (fault: FaultEvent) => void;
type LifecycleListener = (event: AdapterLifecycleEvent) => void;

/**
 * Shared adapter implementation: the lifecycle state machine, boundary
 * validation, subscriber fan-out, and command gating — everything a vendor
 * integration gets for free so simulator adapters differ only in their vendor
 * hooks. Concrete adapters implement the do* hooks; none of them can bypass
 * command gating or emit unvalidated records — both are enforced here.
 */
export abstract class BaseRobotAdapter implements RobotAdapter {
  readonly vendor: string;
  readonly apiVersion: string;
  protected readonly clock: Clock;

  private currentState: AdapterLifecycleState = "disconnected";
  private stateDetail = "not connected";
  private connectedSince: string | null = null;
  private lastEventAt: string | null = null;
  private readonly telemetryListeners = new Set<TelemetryListener>();
  private readonly faultListeners = new Set<FaultListener>();
  private readonly lifecycleListeners = new Set<LifecycleListener>();
  private readonly tickets = new Map<string, CommandTicketState>();
  private ticketCount = 0;

  constructor(init: { vendor: string; apiVersion: string; clock: Clock }) {
    this.vendor = init.vendor;
    this.apiVersion = init.apiVersion;
    this.clock = init.clock;
  }

  /** Current lifecycle state — for tests and logging; the contract surface is healthCheck(). */
  get lifecycleState(): AdapterLifecycleState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    if (this.currentState !== "disconnected") {
      throw new AdapterLifecycleError(
        `connect() requires state "disconnected", got "${this.currentState}"`,
      );
    }
    this.transition("connecting", "connect() requested");
    await this.doConnect();
    this.connectedSince = this.clock.now();
    this.transition("connected", "connect() succeeded");
  }

  async disconnect(): Promise<void> {
    if (this.currentState === "disconnected") return; // idempotent teardown
    if (this.currentState === "connecting" || this.currentState === "reconnecting") {
      throw new AdapterLifecycleError(`disconnect() cannot interrupt "${this.currentState}"`);
    }
    await this.doDisconnect();
    this.connectedSince = null;
    this.transition("disconnected", "disconnect() requested");
  }

  async healthCheck(): Promise<AdapterHealth> {
    return {
      state: this.currentState,
      detail: this.stateDetail,
      connectedSince: this.connectedSince,
      lastEventAt: this.lastEventAt,
    };
  }

  async listRobots(): Promise<readonly Robot[]> {
    this.assertInteractive("listRobots");
    const robots = await this.fetchRobots();
    return robots.map((robot, index) => requireValid(RobotSchema, robot, `listRobots()[${index}]`));
  }

  subscribeTelemetry(cb: TelemetryListener): Unsubscribe {
    return this.subscribe(this.telemetryListeners, cb);
  }

  subscribeFaults(cb: FaultListener): Unsubscribe {
    return this.subscribe(this.faultListeners, cb);
  }

  subscribeLifecycle(cb: LifecycleListener): Unsubscribe {
    return this.subscribe(this.lifecycleListeners, cb);
  }

  async sendCommand(cmd: RobotCommand): Promise<CommandTicket> {
    this.assertInteractive("sendCommand");
    const robot = await this.getRobot(cmd.robotId);
    if (!robot) {
      throw new UnknownRobotError(this.vendor, cmd.robotId);
    }
    // Gate BEFORE dispatch: an unpermitted command never reaches the simulator.
    assertCommandPermitted(robot, cmd.command);
    this.ticketCount += 1;
    const ticket: CommandTicket = {
      ticketId: `${this.vendor}-t-${String(this.ticketCount).padStart(6, "0")}`,
      robotId: cmd.robotId,
      command: cmd.command,
      status: "accepted",
      issuedAt: this.clock.now(),
    };
    this.tickets.set(ticket.ticketId, { ticket, outcome: "pending", settledAt: null });
    await this.dispatchCommand(ticket, robot);
    return ticket;
  }

  async pollTicket(ticketId: string): Promise<CommandTicketState> {
    const state = this.tickets.get(ticketId);
    if (!state) {
      throw new UnknownTicketError(ticketId);
    }
    return state;
  }

  // ---- hooks for concrete adapters ----

  protected abstract doConnect(): Promise<void>;
  protected abstract doDisconnect(): Promise<void>;
  protected abstract getRobot(robotId: string): Promise<Robot | null>;
  /** Vendor-normalized capability records; validated against core-schema here. */
  protected abstract fetchRobots(): Promise<readonly Robot[]>;
  protected abstract dispatchCommand(ticket: CommandTicket, robot: Robot): Promise<void>;

  /** Vendor-specific re-establishment after a transport drop. Default: no-op. */
  protected doReconnect(): Promise<void> {
    return Promise.resolve();
  }

  /** Validate + fan out one telemetry sample; malformed records never reach consumers. */
  protected emitTelemetry(sample: TelemetrySample): void {
    const valid = requireValid(TelemetrySampleSchema, sample, "emitTelemetry");
    this.lastEventAt = valid.ts;
    for (const listener of this.telemetryListeners) {
      listener(valid);
    }
  }

  protected emitFault(fault: FaultEvent): void {
    const valid = requireValid(FaultEventSchema, fault, "emitFault");
    this.lastEventAt = valid.ts;
    for (const listener of this.faultListeners) {
      listener(valid);
    }
  }

  protected settleTicket(ticketId: string, outcome: "succeeded" | "failed"): void {
    const state = this.tickets.get(ticketId);
    if (!state) {
      throw new UnknownTicketError(ticketId);
    }
    if (state.outcome !== "pending") {
      throw new AdapterLifecycleError(`Ticket "${ticketId}" already settled as "${state.outcome}"`);
    }
    this.tickets.set(ticketId, { ...state, outcome, settledAt: this.clock.now() });
  }

  protected markDegraded(detail: string): void {
    if (this.currentState !== "connected") {
      throw new AdapterLifecycleError(
        `markDegraded() requires state "connected", got "${this.currentState}"`,
      );
    }
    this.transition("degraded", detail);
  }

  protected clearDegraded(detail: string): void {
    if (this.currentState !== "degraded") {
      throw new AdapterLifecycleError(
        `clearDegraded() requires state "degraded", got "${this.currentState}"`,
      );
    }
    this.transition("connected", detail);
  }

  /** Transport drop → automatic reconnection. Subscriptions survive the drop. */
  protected async reconnect(detail: string): Promise<void> {
    if (this.currentState !== "connected" && this.currentState !== "degraded") {
      throw new AdapterLifecycleError(
        `reconnect() requires "connected" or "degraded", got "${this.currentState}"`,
      );
    }
    this.transition("reconnecting", detail);
    await this.doReconnect();
    this.transition("connected", "reconnect succeeded");
  }

  private transition(to: AdapterLifecycleState, detail: string): void {
    const from = this.currentState;
    this.currentState = to;
    this.stateDetail = detail;
    const event: AdapterLifecycleEvent = { from, to, detail };
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }

  private assertInteractive(operation: string): void {
    if (this.currentState !== "connected" && this.currentState !== "degraded") {
      throw new AdapterNotConnectedError(operation, this.currentState);
    }
  }

  private subscribe<L>(listeners: Set<L>, listener: L): Unsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
}
