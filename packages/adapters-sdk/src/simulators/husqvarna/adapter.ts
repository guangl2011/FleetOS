import type { Robot, TelemetrySample } from "@fleetos/core-schema";

import type { HusqvarnaFaultCode } from "./device.js";
import { ManualClock } from "../../clock.js";
import type { CommandTicket } from "../../adapter.js";
import {
  AdapterLifecycleError,
  AdapterNotConnectedError,
  BaseRobotAdapter,
} from "../../lifecycle.js";
import type { SimulatorAdapterOptions } from "../shared/device-core.js";
import {
  deriveConnectivitySchedule,
  deriveFaultSchedule,
  uplinkDownAt,
} from "../shared/fault-schedule.js";
import type { ConnectivityDrop, ScheduledFault } from "../shared/fault-schedule.js";
import { FaultSequencer } from "../shared/fault-sequencer.js";
import { withDegradedConfidence } from "../shared/registry.js";
import { HusqvarnaPlannerSim } from "./device.js";
import {
  HUSQVARNA_COMMAND_TO_ACTION,
  HUSQVARNA_FAULT_CODE_MAP,
  HUSQVARNA_FAULT_TYPE_TO_CODE,
  husqvarnaStatusToTelemetry,
} from "./normalize.js";
import { HUSQVARNA_ROBOTS } from "./registry.js";

/**
 * Husqvarna mower simulator (spec D1, first physical batch): a modeled Open
 * API behind the standard RobotAdapter contract. Deterministic by
 * construction — a ManualClock steps time, tick() is the only scheduler, and
 * the seeded schedules derive up front.
 *
 * Vendor quirks modeled here:
 * - OAuth-style access token with a TTL: expiry degrades the connection for
 *   exactly one tick (telemetry gap), then auto-refreshes — the one-tick gap
 *   is the observable a connectivity test can assert on;
 * - planner-style commands issued to a work planner (SET_NO_GO_ZONE is not
 *   in this vendor's allow-list — work zones are planner-managed);
 * - position is only reported while the device has a GPS fix.
 *
 * Contract-suite drivers (public): tick(), injectFaultProfile(),
 * dropTransport(), degrade(), recover(), armFaultScenario(),
 * armConnectivityScenario(), setGpsFix().
 */
export class HusqvarnaMowerAdapter extends BaseRobotAdapter {
  private readonly device: HusqvarnaPlannerSim;
  private readonly robots: readonly Robot[];
  private readonly faults = new FaultSequencer(this.vendor);
  private readonly simClock: ManualClock;
  private readonly tokenTtlTicks: number;
  private faultSchedule: readonly ScheduledFault[] = [];
  private dropSchedule: readonly ConnectivityDrop[] = [];
  private tokenTicksRemaining = 0;
  private tokenExpiredThisTick = false;
  private tickIndex = 0;

  constructor(options: SimulatorAdapterOptions & { tokenTtlTicks?: number } = {}) {
    const clock = options.clock ?? new ManualClock();
    super({ vendor: "husqvarna", apiVersion: "openapi-sim-1.0", clock });
    this.simClock = clock;
    this.tokenTtlTicks = options.tokenTtlTicks ?? 3;
    this.robots = structuredClone(HUSQVARNA_ROBOTS);
    this.device = new HusqvarnaPlannerSim(this.robots.map((robot) => robot.robotId));
  }

  // ---- scripted scenario surface (contract-suite drivers) ----

  /** Advances one simulated tick; emits one telemetry sample per uplinked mower. */
  tick(): void {
    this.requireInteractiveTick();
    this.tickIndex += 1;
    this.tokenExpiredThisTick = false;
    this.emitScheduledFaults();
    this.applyDropSchedule();
    this.stepTokenLifecycle();
    this.device.tick();
    this.emitTelemetryForLinkedRobots();
    this.simClock.advanceSeconds(60);
  }

  /** Emits the seeded fault profile — all six normalized classes, fixed order. */
  injectFaultProfile(): void {
    const [primary, secondary] = this.primarySecondaryIds();
    this.emitVendorFault(primary, "H01_BATTERY_LOW");
    this.emitVendorFault(primary, "H02_LIFT_DETECTED");
    this.emitVendorFault(secondary, "H03_GPS_SIGNAL_WEAK");
    this.emitTransportFault(primary, "simulated connection drop before token refresh");
    this.emitVendorFault(secondary, "H04_WEATHER_TIMER");
    this.emitVendorFault(primary, "H05_SERVICE_DUE");
  }

  /**
   * Targeted scenario driver: emit one vendor-conformant fault on a specific
   * robot on demand (contract suite, demo harness) — the seeded profiles and
   * schedules fire on fixed or derived robots only.
   */
  injectVendorFault(
    robotId: string,
    code: HusqvarnaFaultCode,
    note = "targeted scenario injection",
  ): void {
    this.emitVendorFault(robotId, code, note);
  }

  /** Drops the vendor connection: COMMS_LOST, then automatic reconnect. */
  async dropTransport(): Promise<void> {
    const [primary] = this.primarySecondaryIds();
    this.emitTransportFault(primary, "connection dropped mid-stream");
    await this.reconnect("connection dropped");
  }

  /** Public driver for the degraded lifecycle state (contract suite). */
  degrade(reason: string): void {
    this.markDegraded(reason);
  }

  /** Public driver: leave the degraded lifecycle state (contract suite). */
  recover(): void {
    this.clearDegraded("telemetry recovered");
  }

  /** Scenario driver: forces a mower's GPS fix state (GNSS degradation). */
  setGpsFix(robotId: string, fix: "OK" | "NONE"): void {
    this.device.setGpsFix(robotId, fix);
  }

  /**
   * Arms a seeded fault scenario: the integer seed derives the whole fault
   * schedule up front (pure derivation in shared/fault-schedule); subsequent
   * ticks replay it. Same seed → identical event sequence (determinism
   * convention, testing plan §1).
   */
  armFaultScenario(seed: number, eventCount = 6): readonly ScheduledFault[] {
    this.tickIndex = 0;
    this.faultSchedule = deriveFaultSchedule(seed, this.robotIds(), eventCount, eventCount + 6);
    this.dropSchedule = [];
    return this.faultSchedule;
  }

  /**
   * Arms the connectivity-degradation scenario: per-robot uplink drop windows
   * derived from the seed. While a mower's uplink is down it emits no
   * telemetry and the adapter surfaces COMMS_LOST for it; when every uplink
   * is down the adapter itself goes degraded.
   */
  armConnectivityScenario(seed: number): readonly ConnectivityDrop[] {
    this.tickIndex = 0;
    this.dropSchedule = deriveConnectivitySchedule(seed, this.robotIds(), 12);
    this.faultSchedule = [];
    return this.dropSchedule;
  }

  /** Test seam: forces the token near expiry (token-lifecycle determinism). */
  expireTokenNextTick(): void {
    this.tokenTicksRemaining = 1;
  }

  // ---- RobotAdapter hooks ----

  protected async doConnect(): Promise<void> {
    // Modeled OAuth token grant on connection.
    this.tokenTicksRemaining = this.tokenTtlTicks;
  }

  protected async doDisconnect(): Promise<void> {}

  protected async getRobot(robotId: string): Promise<Robot | null> {
    return this.robots.find((robot) => robot.robotId === robotId) ?? null;
  }

  protected async fetchRobots(): Promise<readonly Robot[]> {
    if (this.lifecycleState !== "degraded") {
      return structuredClone(this.robots);
    }
    return withDegradedConfidence(this.robots);
  }

  protected async dispatchCommand(ticket: CommandTicket, robot: Robot): Promise<void> {
    const action = HUSQVARNA_COMMAND_TO_ACTION[ticket.command];
    if (!action) {
      // Gating rejects this before dispatch; the guard keeps the map lookup total.
      throw new AdapterLifecycleError(
        `Robot "${robot.robotId}" (husqvarna) does not permit ${ticket.command}`,
      );
    }
    this.device.applyCommand(ticket.robotId, action);
    this.settleTicket(ticket.ticketId, "succeeded"); // planner REST settles synchronously
  }

  // ---- internals ----

  /**
   * Token lifecycle: decrement per tick; on expiry the connection degrades
   * for one tick (no telemetry), then refreshes. If a seeded connectivity
   * drop already owns the degraded state, refresh happens silently.
   */
  private stepTokenLifecycle(): void {
    if (this.tokenTicksRemaining > 0) {
      this.tokenTicksRemaining -= 1;
      if (this.tokenTicksRemaining > 0) return;
      this.tokenExpiredThisTick = true;
      const tokenOwnsDegraded = this.lifecycleState === "connected";
      if (tokenOwnsDegraded) {
        this.markDegraded("access token expired; refreshing");
      }
      this.tokenTicksRemaining = this.tokenTtlTicks;
      if (tokenOwnsDegraded) {
        this.clearDegraded("access token refreshed");
      }
      return;
    }
    // Token accounting only runs while connected or degraded; reset defensively.
    this.tokenTicksRemaining = this.tokenTtlTicks;
  }

  private robotIds(): string[] {
    return this.robots.map((robot) => robot.robotId);
  }

  private primarySecondaryIds(): [string, string] {
    const ids = this.robotIds();
    const primary = ids[0];
    if (!primary) {
      throw new AdapterLifecycleError("husqvarna simulator requires at least one mower");
    }
    return [primary, ids[1] ?? primary];
  }

  private requireInteractiveTick(): void {
    if (this.lifecycleState !== "connected" && this.lifecycleState !== "degraded") {
      throw new AdapterNotConnectedError("tick()", this.lifecycleState);
    }
  }

  private emitScheduledFaults(): void {
    for (const scheduled of this.faultSchedule) {
      if (scheduled.tickIndex !== this.tickIndex) continue;
      const code = HUSQVARNA_FAULT_TYPE_TO_CODE[scheduled.faultType];
      if (code) {
        this.emitVendorFault(scheduled.robotId, code, "seeded scenario");
      } else {
        this.emitTransportFault(scheduled.robotId, "scheduled link loss (seeded scenario)");
      }
    }
  }

  private applyDropSchedule(): void {
    for (const robotId of this.robotIds()) {
      const down = uplinkDownAt(this.dropSchedule, robotId, this.tickIndex);
      const wasUp = this.device.uplinkUp(robotId);
      if (wasUp && down) {
        this.device.setUplink(robotId, false);
        this.emitTransportFault(robotId, "robot uplink dropped (seeded scenario)");
      } else if (!wasUp && !down) {
        this.device.setUplink(robotId, true);
      }
    }
    // Total loss degrades the adapter; recovery only applies when the seeded
    // schedule (not a manual degrade()) owns the degraded state.
    const allDown = this.robotIds().every((robotId) => !this.device.uplinkUp(robotId));
    const scheduleOwnsState = this.dropSchedule.length > 0;
    if (allDown && this.lifecycleState === "connected") {
      this.markDegraded("all robot uplinks down (seeded scenario)");
    } else if (scheduleOwnsState && !allDown && this.lifecycleState === "degraded") {
      this.clearDegraded("an uplink recovered (seeded scenario)");
    }
  }

  private emitTelemetryForLinkedRobots(): void {
    // A token expiry in this tick blanks the telemetry window entirely —
    // the observable one-tick gap.
    if (this.tokenExpiredThisTick) return;
    const ts = this.simClock.now();
    for (const status of this.device.listStatuses()) {
      if (!status.system.connected) continue;
      const sample: TelemetrySample = husqvarnaStatusToTelemetry(status, ts);
      this.emitTelemetry(sample);
    }
  }

  private emitVendorFault(
    robotId: string,
    code: keyof typeof HUSQVARNA_FAULT_CODE_MAP,
    note = "seeded fault profile",
  ): void {
    const mapping = HUSQVARNA_FAULT_CODE_MAP[code];
    this.device.raiseError(robotId, code);
    this.emitFault(
      this.faults.build({
        robotId,
        ts: this.simClock.now(),
        type: mapping.type,
        severity: mapping.severity,
        message: mapping.message,
        detail: { vendorCode: code, note },
      }),
    );
  }

  private emitTransportFault(robotId: string, note: string): void {
    this.emitFault(
      this.faults.build({
        robotId,
        ts: this.simClock.now(),
        type: "COMMS_LOST",
        severity: "critical",
        message: "vendor connection lost",
        detail: { note },
      }),
    );
  }
}

/** Factory — the shape every simulator factory takes (mirrors the reference adapter). */
export function createHusqvarnaMowerAdapter(
  options: SimulatorAdapterOptions & { tokenTtlTicks?: number } = {},
): HusqvarnaMowerAdapter {
  return new HusqvarnaMowerAdapter(options);
}
