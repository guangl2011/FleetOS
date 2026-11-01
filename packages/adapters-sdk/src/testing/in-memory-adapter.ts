import { exampleRobotMower, exampleRobotScrubber } from "@fleetos/core-schema";
import type { FaultType, Robot } from "@fleetos/core-schema";

import type { CommandTicket } from "../adapter.js";
import { ManualClock } from "../clock.js";
import { AdapterLifecycleError, AdapterNotConnectedError, BaseRobotAdapter } from "../lifecycle.js";

/** Scenario constants — all deterministic, no wall clock, no randomness. */
const TICK_SECONDS = 60;
const DRAIN_PCT_PER_TICK = 2;
const CHARGE_PCT_PER_TICK = 8;
const PROGRESS_PCT_PER_TICK = 5;
const DEGRADED_CONFIDENCE_FACTOR = 0.5;
const FIXED_POSE = { lat: 47.6062, lon: -122.3321 };

interface SimState {
  batteryPct: number;
  charging: boolean;
  running: boolean;
  paused: boolean;
  progressPct: number;
}

export interface InMemoryAdapterOptions {
  readonly vendor?: string;
  readonly apiVersion?: string;
  readonly robots?: readonly Robot[];
  readonly clock?: ManualClock;
}

/** Canonical fixture robots re-vendored as neutral in-memory devices (deep-copied). */
function defaultRegistry(): Robot[] {
  const mower = structuredClone(exampleRobotMower);
  mower.robotId = "in-memory-mower-01";
  mower.vendor = "in-memory-sim";
  mower.model = "sim-mower-m1";
  mower.compliance.dataFlow.oemCloud = "in-memory-sim-cloud";
  const scrubber = structuredClone(exampleRobotScrubber);
  scrubber.robotId = "in-memory-scrubber-01";
  scrubber.vendor = "in-memory-sim";
  scrubber.model = "sim-scrubber-s1";
  scrubber.compliance.dataFlow.oemCloud = "in-memory-sim-local";
  return [mower, scrubber];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Reference in-memory adapter: a fully functional RobotAdapter with scripted,
 * deterministic behavior — the self-check target for the shared contract
 * suite and the template the four simulator adapters will follow. Devices
 * settle commands synchronously and only advance when tick() is called.
 *
 * Test/scenario drivers (public): tick(), injectFaultProfile(),
 * dropTransport(), degrade(), recover().
 */
export class InMemoryAdapter extends BaseRobotAdapter {
  private readonly registry: readonly Robot[];
  private readonly sim = new Map<string, SimState>();
  /** Same clock instance handed to the base — typed as ManualClock for tick(). */
  private readonly simClock: ManualClock;
  private faultCount = 0;

  constructor(options: InMemoryAdapterOptions = {}) {
    const clock = options.clock ?? new ManualClock();
    const vendor = options.vendor ?? "in-memory-sim";
    super({ vendor, apiVersion: options.apiVersion ?? "1.0.0", clock });
    this.simClock = clock;
    this.registry = options.robots ? structuredClone(options.robots) : defaultRegistry();
    const mismatched = this.registry.filter((robot) => robot.vendor !== vendor);
    if (mismatched.length > 0) {
      const first = mismatched[0];
      throw new AdapterLifecycleError(
        `robots ${mismatched.map((r) => r.robotId).join(", ")} carry vendor "${first?.vendor}", but the adapter vendor is "${vendor}"`,
      );
    }
    for (const robot of this.registry) {
      this.sim.set(robot.robotId, {
        batteryPct: 80,
        charging: false,
        running: false,
        paused: false,
        progressPct: 0,
      });
    }
  }

  // ---- scripted scenario surface (contract-suite drivers) ----

  /** Advances the simulated clock one step and emits one telemetry sample per robot. */
  tick(): void {
    if (this.lifecycleState !== "connected" && this.lifecycleState !== "degraded") {
      throw new AdapterNotConnectedError("tick()", this.lifecycleState);
    }
    const ts = this.simClock.now();
    for (const [robotId, state] of this.sim) {
      let progressToEmit: number | null = null;
      if (state.charging) {
        state.batteryPct = Math.min(100, state.batteryPct + CHARGE_PCT_PER_TICK);
      } else if (state.running && !state.paused) {
        state.batteryPct = Math.max(0, state.batteryPct - DRAIN_PCT_PER_TICK);
        state.progressPct = Math.min(100, state.progressPct + PROGRESS_PCT_PER_TICK);
        progressToEmit = state.progressPct;
        if (state.progressPct >= 100) {
          // Task completes on the tick that emits the final 100% sample.
          state.running = false;
          state.progressPct = 0;
        }
      }
      this.emitTelemetry({
        robotId,
        ts,
        batteryPct: state.batteryPct,
        charging: state.charging,
        pose: FIXED_POSE,
        ...(progressToEmit === null ? {} : { progressPct: progressToEmit }),
      });
    }
    this.simClock.advanceSeconds(TICK_SECONDS);
  }

  /** Emits the seeded fault profile — all six normalized classes, fixed order. */
  injectFaultProfile(): void {
    const primary = this.robotIdAt(0);
    const secondary = this.registry.length > 1 ? this.robotIdAt(1) : primary;
    this.emitNormalizedFault(
      "BATTERY",
      "critical",
      primary,
      "Battery below dispatch reserve floor",
      "simulated voltage sag",
    );
    this.emitNormalizedFault(
      "STUCK",
      "warning",
      primary,
      "Robot reports it is stuck",
      "simulated terrain stop",
    );
    this.emitNormalizedFault(
      "SENSOR_DEGRADED",
      "warning",
      secondary,
      "Sensor quality degraded",
      "simulated lidar occlusion",
    );
    this.emitNormalizedFault(
      "COMMS_LOST",
      "critical",
      primary,
      "Uplink lost for 90 seconds",
      "simulated link failure",
    );
    this.emitNormalizedFault(
      "WEATHER_HOLD",
      "info",
      secondary,
      "Weather hold active at site",
      "simulated rain window",
    );
    this.emitNormalizedFault(
      "MAINTENANCE_DUE",
      "info",
      primary,
      "Blade hours past maintenance interval",
      "simulated hour meter",
    );
  }

  /** Drops the vendor transport: emits COMMS_LOST, then reconnects automatically. */
  async dropTransport(): Promise<void> {
    const primary = this.robotIdAt(0);
    this.emitNormalizedFault(
      "COMMS_LOST",
      "critical",
      primary,
      "Transport dropped mid-stream",
      "simulated link failure",
    );
    await this.reconnect("transport dropped");
  }

  /** Public driver for the degraded lifecycle state. */
  degrade(reason: string): void {
    this.markDegraded(reason);
  }

  /** Public driver: leave the degraded state. */
  recover(): void {
    this.clearDegraded("telemetry recovered");
  }

  // ---- RobotAdapter hooks ----

  protected async doConnect(): Promise<void> {}

  protected async doDisconnect(): Promise<void> {}

  protected async getRobot(robotId: string): Promise<Robot | null> {
    return this.registry.find((robot) => robot.robotId === robotId) ?? null;
  }

  protected async fetchRobots(): Promise<readonly Robot[]> {
    // Deep-copy so consumers can never mutate the registry; degraded adapters
    // report halved confidence — data quality the world model re-weights.
    if (this.lifecycleState !== "degraded") {
      return structuredClone(this.registry);
    }
    return structuredClone(this.registry).map((robot) => ({
      ...robot,
      confidence: clamp01(robot.confidence * DEGRADED_CONFIDENCE_FACTOR),
    }));
  }

  protected async dispatchCommand(ticket: CommandTicket, _robot: Robot): Promise<void> {
    const state = this.sim.get(ticket.robotId);
    if (!state) {
      throw new AdapterLifecycleError(`sim state missing for robot "${ticket.robotId}"`);
    }
    switch (ticket.command) {
      case "START_TASK":
        state.running = true;
        state.paused = false;
        state.charging = false;
        break;
      case "PAUSE":
        state.paused = true;
        break;
      case "RESUME":
        state.paused = false;
        break;
      case "DOCK_CHARGE":
        state.charging = true;
        state.running = false;
        break;
      case "RETURN_HOME":
        state.charging = false;
        state.running = false;
        break;
      case "ABORT":
        state.running = false;
        state.paused = false;
        break;
      case "SET_NO_GO_ZONE":
        // Honored in-memory; the reference sim keeps no geofence model.
        break;
    }
    this.settleTicket(ticket.ticketId, "succeeded"); // synchronous simulated device
  }

  // ---- internals ----

  private robotIdAt(index: number): string {
    const robot = this.registry[index];
    if (!robot) {
      throw new AdapterLifecycleError(`no robot at registry index ${index}`);
    }
    return robot.robotId;
  }

  private emitNormalizedFault(
    type: FaultType,
    severity: "info" | "warning" | "critical",
    robotId: string,
    message: string,
    note: string,
  ): void {
    this.faultCount += 1;
    this.emitFault({
      faultId: `${this.vendor}-f-${String(this.faultCount).padStart(6, "0")}`,
      robotId,
      ts: this.clock.now(),
      type,
      severity,
      message,
      detail: { vendor: this.vendor, note },
    });
  }
}

/** Factory for the reference adapter — the shape every simulator factory will take. */
export function createInMemoryAdapter(options: InMemoryAdapterOptions = {}): InMemoryAdapter {
  return new InMemoryAdapter(options);
}
