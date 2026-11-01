import type { Robot, TelemetrySample } from "@fleetos/core-schema";

import { ManualClock } from "../../clock.js";
import type { CommandTicket } from "../../adapter.js";
import { AdapterNotConnectedError, BaseRobotAdapter } from "../../lifecycle.js";
import type { SimulatorAdapterOptions } from "../shared/device-core.js";
import {
  deriveConnectivitySchedule,
  deriveFaultSchedule,
  uplinkDownAt,
} from "../shared/fault-schedule.js";
import type { ConnectivityDrop, ScheduledFault } from "../shared/fault-schedule.js";
import { FaultSequencer } from "../shared/fault-sequencer.js";
import { withDegradedConfidence } from "../shared/registry.js";
import { NavimowMowerDevice } from "./device.js";
import {
  NAVIMOW_COMMAND_TO_ACTION,
  NAVIMOW_FAULT_CODE_MAP,
  NAVIMOW_FAULT_TYPE_TO_CODE,
  navimowStatusToTelemetry,
} from "./normalize.js";
import { NAVIMOW_ROBOTS } from "./registry.js";

/**
 * Navimow (九号) mower simulator (spec D1, first physical batch): a modeled
 * cloud-to-cloud REST API behind the standard RobotAdapter contract.
 * Deterministic by construction — a ManualClock steps time, tick() is the
 * only scheduler, and the seeded schedules derive up front.
 *
 * Vendor quirks modeled here:
 * - cloud RTT: command tickets settle asynchronously — dispatch applies the
 *   effect immediately, then settlement is queued as a microtask (the
 *   modeled cloud round-trip), so a poll within the same dispatch turn sees
 *   "pending" first;
 * - a START_TASK with no RTK fix is rejected by the cloud (ticket settles
 *   "failed") and surfaces a normalized SENSOR_DEGRADED fault;
 * - position is only reported with a good RTK fix.
 *
 * Contract-suite drivers (public): tick(), injectFaultProfile(),
 * dropTransport(), degrade(), recover(), armFaultScenario(),
 * armConnectivityScenario(), setRtkStatus().
 */
export class NavimowMowerAdapter extends BaseRobotAdapter {
  private readonly device: NavimowMowerDevice;
  private readonly robots: readonly Robot[];
  private readonly faults = new FaultSequencer(this.vendor);
  private readonly simClock: ManualClock;
  private faultSchedule: readonly ScheduledFault[] = [];
  private dropSchedule: readonly ConnectivityDrop[] = [];
  private tickIndex = 0;

  constructor(options: SimulatorAdapterOptions = {}) {
    const clock = options.clock ?? new ManualClock();
    super({ vendor: "navimow", apiVersion: "openapi-sim-2.1", clock });
    this.simClock = clock;
    this.robots = structuredClone(NAVIMOW_ROBOTS);
    this.device = new NavimowMowerDevice(this.robots.map((robot) => robot.robotId));
  }

  // ---- scripted scenario surface (contract-suite drivers) ----

  /** Advances one simulated tick; emits one telemetry sample per uplinked device. */
  tick(): void {
    this.requireInteractiveTick();
    this.tickIndex += 1;
    this.emitScheduledFaults();
    this.applyDropSchedule();
    this.device.tick();
    this.emitTelemetryForLinkedRobots();
    this.simClock.advanceSeconds(60);
  }

  /** Emits the seeded fault profile — all six normalized classes, fixed order. */
  injectFaultProfile(): void {
    const [primary, secondary] = this.primarySecondaryIds();
    this.emitVendorFault(primary, "N01_BATTERY_LOW");
    this.emitVendorFault(primary, "N02_WHEEL_BLOCKED");
    this.emitVendorFault(secondary, "N03_RTK_SIGNAL_WEAK");
    this.emitTransportFault(primary, "simulated MQTT keepalive timeout");
    this.emitVendorFault(secondary, "N04_RAIN_DETECTED");
    this.emitVendorFault(primary, "N05_BLADE_SERVICE_DUE");
  }

  /** Drops the vendor cloud transport: COMMS_LOST, then automatic reconnect. */
  async dropTransport(): Promise<void> {
    const [primary] = this.primarySecondaryIds();
    this.emitTransportFault(primary, "cloud transport dropped mid-stream");
    await this.reconnect("cloud transport dropped");
  }

  /** Public driver for the degraded lifecycle state (contract suite). */
  degrade(reason: string): void {
    this.markDegraded(reason);
  }

  /** Public driver: leave the degraded lifecycle state (contract suite). */
  recover(): void {
    this.clearDegraded("telemetry recovered");
  }

  /** Scenario driver: forces a device's RTK fix state (GNSS degradation). */
  setRtkStatus(robotId: string, status: "FIX" | "FLOAT" | "NONE"): void {
    this.device.setRtkStatus(robotId, status);
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
   * Arms the connectivity-degradation scenario: per-robot uplink (MQTT)
   * drop windows derived from the seed. While a device's uplink is down it
   * emits no telemetry and the adapter surfaces COMMS_LOST for it; when every
   * uplink is down the adapter itself goes degraded.
   */
  armConnectivityScenario(seed: number): readonly ConnectivityDrop[] {
    this.tickIndex = 0;
    this.dropSchedule = deriveConnectivitySchedule(seed, this.robotIds(), 12);
    this.faultSchedule = [];
    return this.dropSchedule;
  }

  // ---- RobotAdapter hooks ----

  protected async doConnect(): Promise<void> {}

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

  /**
   * Cloud-to-cloud dispatch: effects apply immediately, but the ticket
   * settles asynchronously (next microtask) — the modeled cloud RTT. A
   * START_TASK without an RTK fix is rejected by the cloud.
   */
  protected async dispatchCommand(ticket: CommandTicket, _robot: Robot): Promise<void> {
    const action = NAVIMOW_COMMAND_TO_ACTION[ticket.command];
    const rejected =
      ticket.command === "START_TASK" && this.device.rtkStatus(ticket.robotId) === "NONE";
    if (rejected) {
      this.emitVendorFault(ticket.robotId, "N03_RTK_SIGNAL_WEAK", "start rejected without RTK fix");
      queueMicrotask(() => this.settleTicket(ticket.ticketId, "failed"));
      return;
    }
    this.device.applyCommand(ticket.robotId, action);
    queueMicrotask(() => this.settleTicket(ticket.ticketId, "succeeded"));
  }

  // ---- internals ----

  private robotIds(): string[] {
    return this.robots.map((robot) => robot.robotId);
  }

  private primarySecondaryIds(): [string, string] {
    const ids = this.robotIds();
    const primary = ids[0];
    if (!primary) {
      throw new Error("navimow simulator requires at least one device");
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
      const code = NAVIMOW_FAULT_TYPE_TO_CODE[scheduled.faultType];
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
    const ts = this.simClock.now();
    for (const status of this.device.listStatuses()) {
      if (!status.mqttOnline) continue;
      const sample: TelemetrySample = navimowStatusToTelemetry(status, ts);
      this.emitTelemetry(sample);
    }
  }

  private emitVendorFault(
    robotId: string,
    code: keyof typeof NAVIMOW_FAULT_CODE_MAP,
    note = "seeded fault profile",
  ): void {
    const mapping = NAVIMOW_FAULT_CODE_MAP[code];
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
        message: "vendor cloud uplink lost",
        detail: { note },
      }),
    );
  }
}

/** Factory — the shape every simulator factory takes (mirrors the reference adapter). */
export function createNavimowMowerAdapter(
  options: SimulatorAdapterOptions = {},
): NavimowMowerAdapter {
  return new NavimowMowerAdapter(options);
}
