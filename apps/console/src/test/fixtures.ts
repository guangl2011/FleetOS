/**
 * Test fixtures — API view shapes built on core-schema's example records, so
 * fixtures cannot drift from the real schemas without a typecheck failure.
 * Shadow slices carry every field DigitalShadowSlice requires.
 */
import type { FaultEvent, Robot } from "@fleetos/core-schema";
import { exampleRobotMower, exampleFleetTask } from "@fleetos/core-schema";
import type { DigitalShadowSlice } from "@fleetos/world-model";

import type { RobotView, SiteView, TaskView } from "../api/types";

/** Full valid slice — the spread target keeps required fields in one place. */
function shadowSlice(overrides: Partial<DigitalShadowSlice>): DigitalShadowSlice {
  return {
    robotId: "robot-mower-01",
    vendor: "greenworks-sim",
    kind: "mower",
    state: "idle",
    confidence: 0.9,
    batteryPct: 80,
    charging: false,
    pose: { lat: 38.91, lon: -77.04 },
    progressPct: null,
    currentTaskId: null,
    lastTelemetryAt: "2026-11-01T13:58:00.000Z",
    dataAgeSeconds: 30,
    activeFault: null,
    lastFault: null,
    activeConstraintPacks: [],
    ...overrides,
  };
}

function commsLostFault(robotId: string): FaultEvent {
  return {
    faultId: `fault-comms-${robotId}`,
    robotId,
    ts: "2026-11-01T13:40:00.000Z",
    type: "COMMS_LOST",
    severity: "critical",
    message: "no telemetry for 90s",
  };
}

function robotView(overrides: {
  readonly robotId: string;
  readonly vendor: string;
  readonly model?: string;
  readonly kind?: Robot["kind"];
  readonly confidence?: number;
  readonly health?: string;
  readonly shadow?: DigitalShadowSlice;
}): RobotView {
  return {
    robot: {
      ...exampleRobotMower,
      robotId: overrides.robotId,
      vendor: overrides.vendor,
      model: overrides.model ?? exampleRobotMower.model,
      kind: overrides.kind ?? "mower",
    },
    confidence: overrides.confidence ?? 0.9,
    health: overrides.health ?? "healthy",
    shadow: overrides.shadow ?? null,
  };
}

export const exampleSites: readonly SiteView[] = [
  { siteId: "site-1", name: "Riverside Business Park", lat: 38.91, lon: -77.04 },
  { siteId: "site-2", name: "Harbor Logistics Campus", lat: 38.87, lon: -77.02 },
  { siteId: "site-3", name: "Westside Commons", lat: 38.95, lon: -77.07 },
];

export const exampleTasks: readonly TaskView[] = [
  {
    taskId: "task-1",
    siteId: "site-1",
    status: "scheduled",
    priority: 60,
    notBefore: "2026-11-01T14:00:00.000Z",
    notAfter: "2026-11-01T15:30:00.000Z",
    estMinutes: 45,
    record: { ...exampleFleetTask, taskId: "task-1", siteId: "site-1", status: "scheduled" },
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T13:00:00.000Z",
  },
  {
    taskId: "task-2",
    siteId: "site-2",
    status: "scheduled",
    priority: 50,
    notBefore: "2026-11-01T16:00:00.000Z",
    notAfter: "2026-11-01T17:00:00.000Z",
    estMinutes: 40,
    record: { ...exampleFleetTask, taskId: "task-2", siteId: "site-2", status: "scheduled" },
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T13:00:00.000Z",
  },
];

/** Vendor variety is the demo bar: 3 fleets on one screen. */
export const exampleRobots: readonly RobotView[] = [
  robotView({
    robotId: "greenworks-1",
    vendor: "greenworks-sim",
    model: "Greenworks OptimusZ 60",
    shadow: shadowSlice({
      robotId: "greenworks-1",
      vendor: "greenworks-sim",
      state: "executing",
      batteryPct: 82,
      pose: { lat: 38.912, lon: -77.038 },
      currentTaskId: "task-1",
      progressPct: 55,
    }),
  }),
  robotView({
    robotId: "navimow-1",
    vendor: "navimow-sim",
    model: "Segway Navimow X3",
    confidence: 0.75,
    shadow: shadowSlice({
      robotId: "navimow-1",
      vendor: "navimow-sim",
      state: "charging",
      batteryPct: 55,
      charging: true,
      pose: { lat: 38.871, lon: -77.022 },
    }),
  }),
  robotView({
    robotId: "husqvarna-1",
    vendor: "husqvarna-sim",
    model: "Husqvarna Automower 550H EPOS",
    confidence: 0.8,
    shadow: shadowSlice({
      robotId: "husqvarna-1",
      vendor: "husqvarna-sim",
      state: "faulted",
      batteryPct: 91,
      pose: { lat: 38.951, lon: -77.072 },
      lastFault: {
        faultId: "fault-weather-husqvarna-1",
        robotId: "husqvarna-1",
        ts: "2026-11-01T13:45:00.000Z",
        type: "WEATHER_HOLD",
        severity: "info",
        message: "rain gauge active; awaiting clear window",
      },
    }),
  }),
];

/** Degraded robot: comms lost, stale confidence, no usable pose. */
export function degradedRobotView(): RobotView {
  return robotView({
    robotId: "greenworks-2",
    vendor: "greenworks-sim",
    confidence: 0.2,
    health: "degraded",
    shadow: shadowSlice({
      robotId: "greenworks-2",
      state: "unreachable",
      confidence: 0.2,
      batteryPct: 40,
      pose: null,
      dataAgeSeconds: 600,
      lastTelemetryAt: "2026-11-01T13:38:00.000Z",
      activeFault: commsLostFault("greenworks-2"),
      lastFault: commsLostFault("greenworks-2"),
    }),
  });
}
