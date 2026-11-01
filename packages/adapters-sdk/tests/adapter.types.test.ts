import type { FaultEvent, Robot, TelemetrySample } from "@fleetos/core-schema";
import { expectTypeOf, it } from "vitest";

import type {
  AdapterHealth,
  AdapterLifecycleEvent,
  AdapterLifecycleState,
  CommandTicket,
  CommandTicketState,
  RobotAdapter,
  RobotCommand,
  Unsubscribe,
} from "../src/adapter.js";

function ticket(): CommandTicket {
  return {
    ticketId: "type-test-t-000001",
    robotId: "robot-1",
    command: "PAUSE",
    status: "accepted",
    issuedAt: "2026-01-01T00:00:00Z",
  };
}

function ticketState(): CommandTicketState {
  return { ticket: ticket(), outcome: "succeeded", settledAt: "2026-01-01T00:00:00Z" };
}

function completeAdapter(): RobotAdapter {
  return {
    vendor: "type-test",
    apiVersion: "1.0.0",
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async (): Promise<AdapterHealth> => ({
      state: "disconnected",
      detail: "type test",
      connectedSince: null,
      lastEventAt: null,
    }),
    listRobots: async (): Promise<readonly Robot[]> => [],
    subscribeTelemetry: (_cb: (sample: TelemetrySample) => void) => () => {},
    subscribeFaults: (_cb: (fault: FaultEvent) => void) => () => {},
    subscribeLifecycle: (_cb: (event: AdapterLifecycleEvent) => void) => () => {},
    sendCommand: async (_cmd: RobotCommand) => ticket(),
    pollTicket: async (_ticketId: string) => ticketState(),
  };
}

it("accepts a complete implementation", () => {
  expectTypeOf(completeAdapter()).toExtend<RobotAdapter>();
});

it("pins the exact member signatures", () => {
  expectTypeOf<RobotAdapter["listRobots"]>().toEqualTypeOf<() => Promise<readonly Robot[]>>();
  expectTypeOf<RobotAdapter["subscribeTelemetry"]>().toEqualTypeOf<
    (cb: (sample: TelemetrySample) => void) => Unsubscribe
  >();
  expectTypeOf<RobotAdapter["subscribeFaults"]>().toEqualTypeOf<
    (cb: (fault: FaultEvent) => void) => Unsubscribe
  >();
  expectTypeOf<RobotAdapter["subscribeLifecycle"]>().toEqualTypeOf<
    (cb: (event: AdapterLifecycleEvent) => void) => Unsubscribe
  >();
  expectTypeOf<RobotAdapter["sendCommand"]>().toEqualTypeOf<
    (cmd: RobotCommand) => Promise<CommandTicket>
  >();
  expectTypeOf<RobotAdapter["pollTicket"]>().toEqualTypeOf<
    (ticketId: string) => Promise<CommandTicketState>
  >();
  expectTypeOf<RobotAdapter["healthCheck"]>().toEqualTypeOf<() => Promise<AdapterHealth>>();
});

it("requires every lifecycle member — removing one breaks compilation", () => {
  const { sendCommand: _omitted, ...withoutSendCommand } = completeAdapter();
  void _omitted;
  // @ts-expect-error — sendCommand is required; adapters cannot opt out of the dispatch contract
  const missingSendCommand: RobotAdapter = withoutSendCommand;
  void missingSendCommand;
});

it("checks command parameters contravariantly — a mismatched parameter type must fail", () => {
  const base = completeAdapter();
  // @ts-expect-error — sendCommand must accept RobotCommand, not a looser parameter type
  const wrongParam: RobotAdapter = { ...base, sendCommand: async (_cmd: string) => ticket() };
  void wrongParam;
});

it("pins the lifecycle-state and outcome unions", () => {
  expectTypeOf<AdapterLifecycleState>().toEqualTypeOf<
    "disconnected" | "connecting" | "connected" | "reconnecting" | "degraded"
  >();
  expectTypeOf<CommandTicketState["outcome"]>().toEqualTypeOf<"pending" | "succeeded" | "failed">();
  expectTypeOf<CommandTicket["status"]>().toEqualTypeOf<"accepted">();
});
