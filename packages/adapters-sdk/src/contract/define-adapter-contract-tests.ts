import {
  FAULT_TYPES,
  FaultEventSchema,
  RobotSchema,
  TelemetrySampleSchema,
} from "@fleetos/core-schema";
import type { FaultEvent, RobotKind, TelemetrySample } from "@fleetos/core-schema";
import { describe, expect, it } from "vitest";

import type { AdapterLifecycleState, CommandTicketState, RobotAdapter } from "../adapter.js";
import { CommandNotPermittedError, unpermittedCommands } from "../gating.js";

/**
 * The shared adapter contract suite (testing plan §3): one identical suite
 * run against every adapter — the reference in-memory adapter today, all
 * four simulator adapters as they land. Zero per-adapter overrides; a
 * per-adapter skip is a failing PR by definition, so the scenario drivers
 * below are required options, not optional hooks.
 */
export interface AdapterContractOptions {
  /** Suite label, e.g. "greenworks-sim". */
  readonly name: string;
  /** Fresh adapter per test — tests must not share connection state. */
  readonly createAdapter: () => Promise<RobotAdapter> | RobotAdapter;
  readonly expectedVendor: string;
  /** Exact set of robot kinds the adapter's fleet must cover. */
  readonly expectedKinds: readonly RobotKind[];
  readonly minRobots?: number;
  /** Drives a scripted telemetry scenario on a connected adapter. */
  readonly runScriptedScenario: (adapter: RobotAdapter) => Promise<void>;
  /** Injects the adapter's seeded fault profile — all six normalized classes. */
  readonly injectFaultProfile: (adapter: RobotAdapter) => Promise<void>;
  /** Drops the vendor transport so the adapter must reconnect. */
  readonly dropTransport: (adapter: RobotAdapter) => Promise<void>;
  /** Moves a connected adapter into the degraded state. */
  readonly degradeAdapter: (adapter: RobotAdapter) => Promise<void>;
}

/** Poll a ticket until terminal (testing plan §3.3); fails loud on a pending budget overrun. */
export async function pollUntilTerminal(
  adapter: RobotAdapter,
  ticketId: string,
  maxAttempts = 25,
): Promise<CommandTicketState> {
  let state = await adapter.pollTicket(ticketId);
  for (let attempt = 1; attempt < maxAttempts && state.outcome === "pending"; attempt += 1) {
    await Promise.resolve(); // microtask yield; no wall clock (determinism convention)
    state = await adapter.pollTicket(ticketId);
  }
  if (state.outcome === "pending") {
    throw new Error(`Ticket "${ticketId}" still pending after ${maxAttempts} polls`);
  }
  return state;
}

export function defineAdapterContractTests(options: AdapterContractOptions): void {
  const { name, createAdapter, expectedVendor, expectedKinds } = options;
  const minRobots = options.minRobots ?? 1;

  describe(`adapter contract: ${name}`, () => {
    it("normalizes robots into schema-valid capability records (§3.1)", async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      try {
        const robots = await adapter.listRobots();
        expect(robots.length).toBeGreaterThanOrEqual(minRobots);
        const ids = new Set<string>();
        for (const robot of robots) {
          const parsed = RobotSchema.safeParse(robot);
          expect(parsed.success, `robot "${robot.robotId}" violates RobotSchema`).toBe(true);
          expect(robot.vendor, `robot "${robot.robotId}" vendor mismatch`).toBe(expectedVendor);
          ids.add(robot.robotId);
        }
        expect(ids.size, "robot ids must be fleet-unique").toBe(robots.length);
        const kinds = [...new Set(robots.map((robot) => robot.kind))].sort();
        expect(kinds, "fleet kinds must exactly cover expectedKinds").toEqual(
          [...expectedKinds].sort(),
        );
      } finally {
        await adapter.disconnect();
      }
    });

    it("delivers a normalized, monotonic telemetry stream for a scripted scenario (§3.2)", async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      const knownIds = new Set((await adapter.listRobots()).map((robot) => robot.robotId));
      const samples: TelemetrySample[] = [];
      adapter.subscribeTelemetry((sample) => samples.push(sample));
      try {
        await options.runScriptedScenario(adapter);
      } finally {
        await adapter.disconnect();
      }
      expect(samples.length).toBeGreaterThan(0);
      const lastTsPerRobot = new Map<string, string>();
      for (const sample of samples) {
        const parsed = TelemetrySampleSchema.safeParse(sample);
        expect(
          parsed.success,
          `telemetry sample violates TelemetrySampleSchema: ${JSON.stringify(sample)}`,
        ).toBe(true);
        expect(knownIds.has(sample.robotId), `unknown robot "${sample.robotId}"`).toBe(true);
        const last = lastTsPerRobot.get(sample.robotId);
        if (last) {
          expect(
            Date.parse(sample.ts),
            "telemetry ts must be monotonic per robot",
          ).toBeGreaterThanOrEqual(Date.parse(last));
        }
        lastTsPerRobot.set(sample.robotId, sample.ts);
      }
    });

    it("accepts every allow-listed command and settles its ticket via poll (§3.3)", async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      try {
        for (const robot of await adapter.listRobots()) {
          for (const command of robot.commands) {
            const ticket = await adapter.sendCommand({ robotId: robot.robotId, command });
            expect(ticket.status).toBe("accepted");
            const settled = await pollUntilTerminal(adapter, ticket.ticketId);
            expect(["succeeded", "failed"]).toContain(settled.outcome);
          }
        }
      } finally {
        await adapter.disconnect();
      }
    });

    it("rejects commands outside the capability allow-list before dispatch (§3.3)", async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      try {
        const robots = await adapter.listRobots();
        const hasNegativeCase = robots.some((robot) => unpermittedCommands(robot).length > 0);
        expect(
          hasNegativeCase,
          "fixture must include a robot whose allow-list is not full — a gating test with no negative case proves nothing",
        ).toBe(true);
        for (const robot of robots) {
          for (const command of unpermittedCommands(robot)) {
            await expect(
              adapter.sendCommand({ robotId: robot.robotId, command }),
            ).rejects.toBeInstanceOf(CommandNotPermittedError);
          }
        }
      } finally {
        await adapter.disconnect();
      }
    });

    it("emits every normalized fault class from the seeded fault profile (§3.4)", async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      const faults: FaultEvent[] = [];
      adapter.subscribeFaults((fault) => faults.push(fault));
      try {
        await options.injectFaultProfile(adapter);
      } finally {
        await adapter.disconnect();
      }
      const seen = new Set(faults.map((fault) => fault.type));
      for (const faultType of FAULT_TYPES) {
        expect(seen.has(faultType), `fault profile did not emit "${faultType}"`).toBe(true);
      }
      for (const fault of faults) {
        const parsed = FaultEventSchema.safeParse(fault);
        expect(parsed.success, `fault violates FaultEventSchema: ${JSON.stringify(fault)}`).toBe(
          true,
        );
      }
    });

    it("reflects connected, degraded, and disconnected states in healthCheck (§3.5)", async () => {
      const adapter = await createAdapter();
      expect((await adapter.healthCheck()).state).toBe("disconnected");
      await adapter.connect();
      expect((await adapter.healthCheck()).state).toBe("connected");
      await options.degradeAdapter(adapter);
      expect((await adapter.healthCheck()).state).toBe("degraded");
      await adapter.disconnect();
      expect((await adapter.healthCheck()).state).toBe("disconnected");
    });

    it("reconnects after a transport drop and resumes streams without resubscription", async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      const transitions: AdapterLifecycleState[] = [];
      adapter.subscribeLifecycle((event) => transitions.push(event.to));
      const samples: TelemetrySample[] = [];
      adapter.subscribeTelemetry((sample) => samples.push(sample));
      const faults: FaultEvent[] = [];
      adapter.subscribeFaults((fault) => faults.push(fault));
      try {
        await options.runScriptedScenario(adapter); // warm the stream
        const countBeforeDrop = samples.length;
        await options.dropTransport(adapter);
        expect((await adapter.healthCheck()).state, "adapter must recover to connected").toBe(
          "connected",
        );
        const reconnectingAt = transitions.indexOf("reconnecting");
        expect(reconnectingAt, "lifecycle must expose the reconnecting transition").toBeGreaterThan(
          -1,
        );
        expect(
          transitions.lastIndexOf("connected"),
          "reconnect must end connected",
        ).toBeGreaterThan(reconnectingAt);
        expect(
          faults.some((fault) => fault.type === "COMMS_LOST"),
          "a transport drop must surface as a normalized COMMS_LOST fault",
        ).toBe(true);
        await options.runScriptedScenario(adapter); // post-reconnect, SAME subscription
        expect(samples.length).toBeGreaterThan(countBeforeDrop);
      } finally {
        await adapter.disconnect();
      }
    });
  });
}
