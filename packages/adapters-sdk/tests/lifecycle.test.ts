import { exampleRobotMower } from "@fleetos/core-schema";
import type { FaultEvent, Robot, TelemetrySample } from "@fleetos/core-schema";
import { describe, expect, it } from "vitest";

import type { CommandTicket } from "../src/adapter.js";
import { ManualClock } from "../src/clock.js";
import {
  AdapterLifecycleError,
  AdapterNotConnectedError,
  BaseRobotAdapter,
  NormalizationError,
  UnknownTicketError,
} from "../src/lifecycle.js";

const robot: Robot = exampleRobotMower;

/** Minimal concrete adapter exposing the protected surface for unit tests. */
class StubAdapter extends BaseRobotAdapter {
  constructor(clock: ManualClock = new ManualClock()) {
    super({ vendor: "stub", apiVersion: "1.0.0", clock });
  }

  emitTelemetryPublic(sample: TelemetrySample): void {
    this.emitTelemetry(sample);
  }

  emitFaultPublic(fault: FaultEvent): void {
    this.emitFault(fault);
  }

  degradePublic(reason: string): void {
    this.markDegraded(reason);
  }

  recoverPublic(): void {
    this.clearDegraded("recovered");
  }

  reconnectPublic(detail: string): Promise<void> {
    return this.reconnect(detail);
  }

  settlePublic(ticketId: string): void {
    this.settleTicket(ticketId, "succeeded");
  }

  protected async doConnect(): Promise<void> {}

  protected async doDisconnect(): Promise<void> {}

  protected async getRobot(robotId: string): Promise<Robot | null> {
    return robotId === robot.robotId ? robot : null;
  }

  protected async fetchRobots(): Promise<readonly Robot[]> {
    return [robot];
  }

  protected async dispatchCommand(ticket: CommandTicket, _robot: Robot): Promise<void> {
    this.settleTicket(ticket.ticketId, "succeeded");
  }
}

const validSample: TelemetrySample = {
  robotId: robot.robotId,
  ts: "2026-01-01T00:00:00Z",
  batteryPct: 72,
  charging: false,
};

function faultOf(type: FaultEvent["type"]): FaultEvent {
  return {
    faultId: "stub-f-000001",
    robotId: robot.robotId,
    ts: "2026-01-01T00:00:00Z",
    type,
    severity: "warning",
    message: "unit-test fault",
  };
}

describe("BaseRobotAdapter lifecycle state machine", () => {
  it("moves disconnected → connecting → connected → disconnected", async () => {
    const adapter = new StubAdapter();
    const states: string[] = [];
    adapter.subscribeLifecycle((event) => states.push(event.to));

    expect((await adapter.healthCheck()).state).toBe("disconnected");
    await adapter.connect();
    expect((await adapter.healthCheck()).state).toBe("connected");
    await adapter.disconnect();
    expect((await adapter.healthCheck()).state).toBe("disconnected");
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("rejects double connect and exposes the transition detail", async () => {
    const adapter = new StubAdapter();
    await adapter.connect();
    let event: { from: string; to: string; detail: string } | undefined;
    adapter.subscribeLifecycle((e) => {
      event = e;
    });
    adapter.degradePublic("probe");
    expect(event).toEqual({ from: "connected", to: "degraded", detail: "probe" });
    await expect(adapter.connect()).rejects.toBeInstanceOf(AdapterLifecycleError);
    await adapter.disconnect();
  });

  it("treats disconnect as idempotent when already disconnected", async () => {
    const adapter = new StubAdapter();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("refuses disconnect during connecting/reconnecting", async () => {
    const adapter = new StubAdapter();
    const pending = adapter.connect();
    await expect(adapter.disconnect()).rejects.toBeInstanceOf(AdapterLifecycleError);
    await pending;
    await adapter.disconnect();
  });

  it("refuses reconnect from disconnected and refuses degrade while disconnected", async () => {
    const adapter = new StubAdapter();
    await expect(adapter.reconnectPublic("nope")).rejects.toBeInstanceOf(AdapterLifecycleError);
    expect(() => adapter.degradePublic("nope")).toThrow(AdapterLifecycleError);
  });
});

describe("BaseRobotAdapter interactive guards", () => {
  it("refuses listRobots and sendCommand while disconnected", async () => {
    const adapter = new StubAdapter();
    await expect(adapter.listRobots()).rejects.toBeInstanceOf(AdapterNotConnectedError);
    await expect(
      adapter.sendCommand({ robotId: robot.robotId, command: "PAUSE" }),
    ).rejects.toBeInstanceOf(AdapterNotConnectedError);
  });

  it("allows interaction while degraded (spec: degraded ≠ offline)", async () => {
    const adapter = new StubAdapter();
    await adapter.connect();
    adapter.degradePublic("partial telemetry loss");
    await expect(adapter.listRobots()).resolves.toHaveLength(1);
    const ticket = await adapter.sendCommand({ robotId: robot.robotId, command: "PAUSE" });
    expect(ticket.status).toBe("accepted");
    await adapter.disconnect();
  });

  it("rejects unknown robots and unknown tickets", async () => {
    const adapter = new StubAdapter();
    await adapter.connect();
    await expect(
      adapter.sendCommand({ robotId: "no-such-robot", command: "PAUSE" }),
    ).rejects.toMatchObject({ name: "UnknownRobotError" });
    await expect(adapter.pollTicket("no-such-ticket")).rejects.toBeInstanceOf(UnknownTicketError);
    await adapter.disconnect();
  });

  it("refuses double settlement of a ticket", async () => {
    const adapter = new StubAdapter();
    await adapter.connect();
    const ticket = await adapter.sendCommand({ robotId: robot.robotId, command: "PAUSE" });
    expect(() => adapter.settlePublic(ticket.ticketId)).toThrow(AdapterLifecycleError);
    await adapter.disconnect();
  });
});

describe("BaseRobotAdapter boundary validation", () => {
  it("delivers valid telemetry to subscribers until they unsubscribe", async () => {
    const adapter = new StubAdapter();
    const received: TelemetrySample[] = [];
    const unsubscribe = adapter.subscribeTelemetry((sample) => received.push(sample));
    adapter.emitTelemetryPublic(validSample);
    unsubscribe();
    adapter.emitTelemetryPublic({ ...validSample, ts: "2026-01-01T00:01:00Z" });
    expect(received).toHaveLength(1);
    expect(received[0]?.batteryPct).toBe(72);
  });

  it("throws NormalizationError on malformed telemetry and faults — never swallowed", () => {
    const adapter = new StubAdapter();
    const received: TelemetrySample[] = [];
    adapter.subscribeTelemetry((sample) => received.push(sample));

    expect(() => adapter.emitTelemetryPublic({ ...validSample, batteryPct: 150 })).toThrow(
      NormalizationError,
    );
    expect(() =>
      adapter.emitFaultPublic({ ...faultOf("BATTERY"), type: "NOT_A_FAULT" as FaultEvent["type"] }),
    ).toThrow(NormalizationError);
    expect(received, "no record may cross the boundary unvalidated").toHaveLength(0);
  });

  it("fans out one fault to every subscriber in registration order", () => {
    const adapter = new StubAdapter();
    const order: string[] = [];
    adapter.subscribeFaults(() => order.push("first"));
    adapter.subscribeFaults(() => order.push("second"));
    adapter.emitFaultPublic(faultOf("STUCK"));
    expect(order).toEqual(["first", "second"]);
  });
});
