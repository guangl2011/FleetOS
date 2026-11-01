import type { Robot, TelemetrySample } from "@fleetos/core-schema";

import type { GreenworksFaultCode } from "./device.js";
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
import { GreenworksMowerDevice } from "./device.js";
import {
  GREENWORKS_COMMAND_TO_ACTION,
  GREENWORKS_FAULT_CODE_MAP,
  GREENWORKS_FAULT_TYPE_TO_CODE,
  greenworksStatusToTelemetry,
} from "./normalize.js";
import { GREENWORKS_ROBOTS } from "./registry.js";

/**
 * Greenworks mower simulator (spec D1, first physical batch): a modeled
 * local-gateway cloud API behind the standard RobotAdapter contract.
 * Deterministic by construction — a ManualClock steps time and tick() is the
 * only scheduler, so scenario runs are CI-reproducible.
 *
 * Contract-suite drivers (public): tick(), injectFaultProfile(),
 * dropTransport(), degrade(), recover(), armFaultScenario(),
 * armConnectivityScenario().
 */
export class GreenworksMowerAdapter extends BaseRobotAdapter {
  private readonly device: GreenworksMowerDevice;
  private readonly robots: readonly Robot[];
  private readonly faults = new FaultSequencer(this.vendor);
  private readonly simClock: ManualClock;
  private faultSchedule: readonly ScheduledFault[] = [];
  private dropSchedule: readonly ConnectivityDrop[] = [];
  private tickIndex = 0;

  constructor(options: SimulatorAdapterOptions = {}) {
    const clock = options.clock ?? new ManualClock();
    super({ vendor: "greenworks", apiVersion: "local-gateway-sim-1", clock });
    this.simClock = clock;
    this.robots = structuredClone(GREENWORKS_ROBOTS);
    this.device = new GreenworksMowerDevice(this.robots.map((robot) => robot.robotId));
  }

  // ---- scripted scenario surface (contract-suite drivers) ----

  /** Advances one simulated tick; emits one telemetry sample per uplinked mower. */
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
    this.emitVendorFault(primary, "E01_BATTERY_LOW");
    this.emitVendorFault(primary, "E02_STALLED");
    this.emitVendorFault(secondary, "E03_BUMPER_OCCLUDED");
    this.emitTransportFault(primary, "simulated gateway link failure");
    this.emitVendorFault(secondary, "E04_RAIN_DELAY");
    this.emitVendorFault(primary, "E05_BLADE_SERVICE_DUE");
  }

  /**
   * Targeted scenario driver: emit one vendor-conformant fault on a specific
   * robot on demand (contract suite, demo harness) — the seeded profiles and
   * schedules fire on fixed or derived robots only.
   */
  injectVendorFault(
    robotId: string,
    code: GreenworksFaultCode,
    note = "targeted scenario injection",
  ): void {
    this.emitVendorFault(robotId, code, note);
  }

  /** Drops the vendor gateway transport: COMMS_LOST, then automatic reconnect. */
  async dropTransport(): Promise<void> {
    const [primary] = this.primarySecondaryIds();
    this.emitTransportFault(primary, "gateway transport dropped mid-stream");
    await this.reconnect("gateway transport dropped");
  }

  /** Public driver for the degraded lifecycle state (contract suite). */
  degrade(reason: string): void {
    this.markDegraded(reason);
  }

  /** Public driver: leave the degraded lifecycle state (contract suite). */
  recover(): void {
    this.clearDegraded("telemetry recovered");
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
   * derived from the seed. While a robot's uplink is down it emits no
   * telemetry and the adapter surfaces COMMS_LOST for it; when every uplink
   * is down the adapter itself goes degraded (total telemetry loss).
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

  protected async dispatchCommand(ticket: CommandTicket, robot: Robot): Promise<void> {
    if (ticket.command === "SET_NO_GO_ZONE") {
      // Gating rejects this before dispatch; the guard keeps the map lookup total.
      throw new AdapterLifecycleError(
        `Robot "${robot.robotId}" (greenworks) does not permit SET_NO_GO_ZONE`,
      );
    }
    const action = GREENWORKS_COMMAND_TO_ACTION[ticket.command];
    this.device.applyCommand(ticket.robotId, action);
    this.settleTicket(ticket.ticketId, "succeeded"); // local gateway settles synchronously
  }

  // ---- internals ----

  private robotIds(): string[] {
    return this.robots.map((robot) => robot.robotId);
  }

  private primarySecondaryIds(): [string, string] {
    const ids = this.robotIds();
    const primary = ids[0];
    if (!primary) {
      throw new AdapterLifecycleError("greenworks simulator requires at least one mower");
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
      const code = GREENWORKS_FAULT_TYPE_TO_CODE[scheduled.faultType];
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
      if (!this.device.uplinkUp(status.mowerId)) continue;
      const sample: TelemetrySample = greenworksStatusToTelemetry(status, ts);
      this.emitTelemetry(sample);
    }
  }

  private emitVendorFault(
    robotId: string,
    code: keyof typeof GREENWORKS_FAULT_CODE_MAP,
    note = "seeded fault profile",
  ): void {
    const mapping = GREENWORKS_FAULT_CODE_MAP[code];
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
        message: "vendor uplink lost",
        detail: { note },
      }),
    );
  }
}

/** Factory — the shape every simulator factory takes (mirrors the reference adapter). */
export function createGreenworksMowerAdapter(
  options: SimulatorAdapterOptions = {},
): GreenworksMowerAdapter {
  return new GreenworksMowerAdapter(options);
}
