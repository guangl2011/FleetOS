import type { ExternalConstraintPack, GeoPoint, Robot } from "@fleetos/core-schema";
import { GREENWORKS_ROBOTS, HUSQVARNA_ROBOTS, NAVIMOW_ROBOTS } from "@fleetos/adapters-sdk";

import type { PartialSchedulingObjective } from "../objective.js";
import type { SchedulableTask } from "../input.js";
import type { ConnectivityWindow, FaultInjection, SimulationScenario } from "../runtime.js";

/**
 * The deterministic benchmark scenario set (spec D1, docx §7 pass bars):
 * every scenario runs both schedulers through the identical runtime with
 * identical fleet, tasks, packs, faults, and connectivity — only the
 * scheduling function differs. Scenario randomness lives entirely in the
 * explicit fault injections and connectivity windows; execution is closed
 * physics, so runs are bit-reproducible (testing plan §4).
 *
 * Where the risk-aware planner's edge comes from (each mechanism is real
 * code, not scenario magic):
 * 1. proactive, price-aware charging (cheapest feasible window, overnight)
 *    vs the baseline's reactive threshold+hysteresis charging at any price;
 * 2. projected-end battery gating vs the baseline's dispatch-time-only
 *    threshold (mid-field battery deaths are interventions);
 * 3. stale/unreachable exclusion vs the baseline's last-known-state dispatch
 *    (commands into a connectivity blackout never arrive);
 * 4. fault-history risk pricing (a repeat offender is down-weighted);
 * 5. slot-level energy pricing (wide-window tasks shift off-peak).
 */

export const SCENARIO_OFFSET_MINUTES = 0; // UTC treated as local clock.

/** Commercial-mowing day: 00:00 → 23:00 local on a Monday. */
const START = "2026-03-16T00:00:00.000Z";
const HORIZON_MINUTES = 1380;

export const BENCHMARK_OBJECTIVE: PartialSchedulingObjective = {
  onTimeWeight: 100,
  batteryReserveFloorPct: 25,
  travelCostPerHour: 50,
  interventionCost: 500,
  energyCostWeight: 1,
};

/** Depot plus five worksites; distances 2–3.6 km from the depot. */
const SITES: ReadonlyMap<string, GeoPoint> = new Map<string, GeoPoint>([
  ["site-h", { lat: 0, lon: 0 }],
  ["site-a", { lat: 0.018, lon: 0.009 }],
  ["site-b", { lat: 0.012, lon: -0.013 }],
  ["site-c", { lat: -0.019, lon: 0.006 }],
  ["site-d", { lat: 0.028, lon: 0.017 }],
  ["site-e", { lat: -0.008, lon: -0.021 }],
]);

export const BENCHMARK_SITES = SITES;
export const HOME_SITE_ID = "site-h";

/** The five-mower benchmark fleet, sourced from the simulator registries. */
export function benchmarkFleet(): readonly Robot[] {
  return [
    GREENWORKS_ROBOTS[0]!,
    GREENWORKS_ROBOTS[1]!,
    NAVIMOW_ROBOTS[0]!,
    NAVIMOW_ROBOTS[1]!,
    HUSQVARNA_ROBOTS[0]!,
  ];
}

function task(
  taskId: string,
  siteId: string,
  estMinutes: number,
  notBefore: string,
  notAfter: string,
  priority: number,
): SchedulableTask {
  return {
    schemaVersion: "1.0.0",
    taskId,
    siteId,
    requirements: { taskTypes: ["mow"] },
    window: { notBefore, notAfter },
    priority,
    status: "pending",
    estMinutes,
  };
}

/**
 * Twenty-nine mowing jobs, ≈52 robot-hours over five robots with overlapping
 * windows — dense enough that reactive charging and greedy nearest-robot
 * dispatch measurably cost on-time completion, loose enough that every task
 * stays individually feasible.
 */
function benchmarkTasks(): readonly SchedulableTask[] {
  const day = "2026-03-16T";
  return [
    // Night/early wave (legal in the core scenario; blocked by the noise
    // ordinance scenario, where the day shift carries the load).
    task("task-t01", "site-a", 75, `${day}00:30:00.000Z`, `${day}05:30:00.000Z`, 80),
    task("task-t02", "site-b", 90, `${day}01:00:00.000Z`, `${day}06:00:00.000Z`, 60),
    task("task-t03", "site-c", 120, `${day}02:00:00.000Z`, `${day}07:30:00.000Z`, 60),
    task("task-t04", "site-e", 60, `${day}03:00:00.000Z`, `${day}07:00:00.000Z`, 40),
    // Morning wave — the first 180-minute monster sits here.
    task("task-t05", "site-a", 90, `${day}06:30:00.000Z`, `${day}11:00:00.000Z`, 70),
    task("task-t06", "site-d", 180, `${day}08:00:00.000Z`, `${day}13:30:00.000Z`, 90),
    task("task-t07", "site-b", 120, `${day}08:30:00.000Z`, `${day}13:30:00.000Z`, 60),
    task("task-t08", "site-c", 75, `${day}09:00:00.000Z`, `${day}13:00:00.000Z`, 50),
    // Afternoon wave — long jobs land when batteries are deep in cycle two.
    task("task-t09", "site-a", 210, `${day}12:30:00.000Z`, `${day}19:00:00.000Z`, 90),
    task("task-t10", "site-e", 120, `${day}13:00:00.000Z`, `${day}18:00:00.000Z`, 60),
    task("task-t11", "site-b", 90, `${day}13:30:00.000Z`, `${day}18:00:00.000Z`, 70),
    task("task-t12", "site-d", 90, `${day}14:00:00.000Z`, `${day}19:00:00.000Z`, 60),
    task("task-t13", "site-c", 180, `${day}14:30:00.000Z`, `${day}20:30:00.000Z`, 50),
    // Evening crunch — the tail lands when reactive-charge fleets sit on
    // depleted batteries; pre-charged fleets keep completing long jobs.
    task("task-t14", "site-a", 60, `${day}16:00:00.000Z`, `${day}21:00:00.000Z`, 40),
    task("task-t15", "site-e", 90, `${day}16:30:00.000Z`, `${day}21:30:00.000Z`, 60),
    task("task-t16", "site-b", 75, `${day}17:00:00.000Z`, `${day}22:00:00.000Z`, 50),
    task("task-t17", "site-d", 150, `${day}17:30:00.000Z`, `${day}22:30:00.000Z`, 60),
    task("task-t18", "site-e", 120, `${day}18:00:00.000Z`, `${day}22:30:00.000Z`, 50),
    task("task-t19", "site-c", 180, `${day}16:30:00.000Z`, `${day}22:30:00.000Z`, 45),
    // Capacity layer — pushes utilization near the fleet's limit so the
    // baseline's reactive charging and greedy nearest-robot dispatch bind:
    // threshold-triggered midday charges pull robots out of the crunch, and
    // long evening tasks land on depleted batteries.
    task("task-t20", "site-c", 90, `${day}07:30:00.000Z`, `${day}11:30:00.000Z`, 70),
    task("task-t21", "site-b", 120, `${day}08:00:00.000Z`, `${day}12:30:00.000Z`, 60),
    task("task-t22", "site-a", 90, `${day}09:00:00.000Z`, `${day}13:00:00.000Z`, 50),
    task("task-t23", "site-e", 150, `${day}10:00:00.000Z`, `${day}15:00:00.000Z`, 60),
    task("task-t24", "site-d", 60, `${day}10:30:00.000Z`, `${day}14:00:00.000Z`, 40),
    task("task-t25", "site-b", 150, `${day}11:30:00.000Z`, `${day}16:30:00.000Z`, 50),
    task("task-t26", "site-c", 90, `${day}12:30:00.000Z`, `${day}17:00:00.000Z`, 45),
    task("task-t27", "site-a", 120, `${day}13:30:00.000Z`, `${day}18:00:00.000Z`, 50),
    task("task-t28", "site-e", 90, `${day}15:30:00.000Z`, `${day}20:00:00.000Z`, 40),
    task("task-t29", "site-d", 120, `${day}16:00:00.000Z`, `${day}21:00:00.000Z`, 45),
  ];
}

/**
 * Noise-ordinance variant of the workload: the four night jobs shift into the
 * morning (an operator facing a 22:00–07:00 ban reschedules, not abandons),
 * keeping total work equal to the core set so all three scenarios stress the
 * fleet identically. The ban still bites: nothing may start before 07:00.
 */
function noiseTasks(): readonly SchedulableTask[] {
  const day = "2026-03-16T";
  return [
    task("task-t01", "site-a", 75, `${day}07:00:00.000Z`, `${day}11:00:00.000Z`, 80),
    task("task-t02", "site-b", 90, `${day}07:30:00.000Z`, `${day}12:00:00.000Z`, 60),
    task("task-t03", "site-c", 120, `${day}08:00:00.000Z`, `${day}13:00:00.000Z`, 60),
    task("task-t04", "site-e", 60, `${day}09:00:00.000Z`, `${day}13:00:00.000Z`, 40),
    ...benchmarkTasks().filter((t) => !(t.taskId >= "task-t01" && t.taskId <= "task-t04")),
  ];
}

/**
 * Slack variant for the tariff-shift assertion: a day-only workload leaves
 * the 21:00–08:00 trough idle, so a price-aware planner can move charging
 * into it while a reactive baseline charges when batteries dip — midday, at
 * peak prices. This is the scenario where the constraint pack demonstrably
 * shifts energy off-peak; the three stress scenarios above saturate the fleet
 * and leave no room to shift.
 */
export function tariffShiftScenario(): SimulationScenario {
  const day = "2026-03-16T";
  const tasks: readonly SchedulableTask[] = [
    task("task-s01", "site-a", 90, `${day}07:00:00.000Z`, `${day}11:00:00.000Z`, 70),
    task("task-s02", "site-b", 60, `${day}07:30:00.000Z`, `${day}11:30:00.000Z`, 50),
    task("task-s03", "site-c", 120, `${day}08:00:00.000Z`, `${day}12:30:00.000Z`, 60),
    task("task-s04", "site-d", 90, `${day}09:00:00.000Z`, `${day}13:00:00.000Z`, 50),
    task("task-s05", "site-e", 60, `${day}09:30:00.000Z`, `${day}13:30:00.000Z`, 40),
    task("task-s06", "site-b", 90, `${day}10:30:00.000Z`, `${day}14:30:00.000Z`, 50),
    task("task-s07", "site-a", 120, `${day}11:00:00.000Z`, `${day}15:30:00.000Z`, 60),
    task("task-s08", "site-d", 60, `${day}12:00:00.000Z`, `${day}16:00:00.000Z`, 40),
    task("task-s09", "site-c", 90, `${day}13:00:00.000Z`, `${day}17:00:00.000Z`, 50),
    task("task-s10", "site-e", 120, `${day}13:30:00.000Z`, `${day}18:00:00.000Z`, 60),
    task("task-s11", "site-a", 60, `${day}14:30:00.000Z`, `${day}18:30:00.000Z`, 40),
    task("task-s12", "site-b", 90, `${day}15:00:00.000Z`, `${day}19:00:00.000Z`, 50),
    task("task-s13", "site-d", 120, `${day}15:30:00.000Z`, `${day}19:30:00.000Z`, 60),
    task("task-s14", "site-e", 90, `${day}16:30:00.000Z`, `${day}20:00:00.000Z`, 50),
  ];
  return {
    ...coreMowingScenario(),
    scenarioId: "peak-tariff-shift",
    seed: 20260319,
    tasks,
    packs: [peakTariffPack()],
  };
}

/** Flat-delta tariff: overnight trough, daytime mid, afternoon peak. */
export function coreTariffPack(): ExternalConstraintPack {
  return {
    schemaVersion: "1.0.0",
    packId: "pack-tariff-core",
    source: "tariff",
    appliesTo: {},
    hard: [],
    soft: [
      {
        constraintId: "constraint-demand-charge",
        description: "Demand-charge aversion during the 14:00–21:00 peak",
        weight: 0.6,
      },
    ],
    costTerms: [
      {
        curveId: "curve-tariff-core",
        currency: "USD",
        points: [
          { at: "2026-03-16T00:00:00.000Z", pricePerKwh: 0.08 },
          { at: "2026-03-16T06:00:00.000Z", pricePerKwh: 0.16 },
          { at: "2026-03-16T14:00:00.000Z", pricePerKwh: 0.42 },
          { at: "2026-03-16T21:00:00.000Z", pricePerKwh: 0.12 },
        ],
      },
    ],
    provenance: {
      origin: "utility tariff sheet, human-entered",
      humanApproved: true,
      extractedBy: "human",
    },
  };
}

/** Sharp 0.60 peak 08:00–17:00 — makes off-peak shifting visible and measurable. */
export function peakTariffPack(): ExternalConstraintPack {
  return {
    schemaVersion: "1.0.0",
    packId: "pack-tariff-peak",
    source: "tariff",
    appliesTo: {},
    hard: [],
    soft: [
      {
        constraintId: "constraint-demand-charge",
        description: "Demand-charge aversion during the 08:00–17:00 peak",
        weight: 0.9,
      },
    ],
    costTerms: [
      {
        curveId: "curve-tariff-peak",
        currency: "USD",
        points: [
          { at: "2026-03-16T00:00:00.000Z", pricePerKwh: 0.09 },
          { at: "2026-03-16T07:00:00.000Z", pricePerKwh: 0.18 },
          { at: "2026-03-16T08:00:00.000Z", pricePerKwh: 0.6 },
          { at: "2026-03-16T17:00:00.000Z", pricePerKwh: 0.18 },
          { at: "2026-03-16T21:00:00.000Z", pricePerKwh: 0.09 },
        ],
      },
    ],
    provenance: {
      origin: "utility tariff sheet, human-entered",
      humanApproved: true,
      extractedBy: "human",
    },
  };
}

/** Noise ordinance: mowing forbidden 22:00–07:00 local (wraps midnight). */
export function noiseOrdinancePack(): ExternalConstraintPack {
  return {
    schemaVersion: "1.0.0",
    packId: "pack-noise-ordinance",
    source: "regulation",
    appliesTo: { robotKinds: ["mower"] },
    hard: [
      {
        rule: "time-window",
        constraintId: "constraint-noise-night",
        description: "Municipal noise ordinance 22:00–07:00: mowing prohibited",
        forbiddenWindows: [{ start: "22:00", end: "07:00" }],
      },
    ],
    soft: [],
    costTerms: [],
    provenance: {
      origin: "city noise ordinance §7.2, human-entered",
      humanApproved: true,
      extractedBy: "human",
    },
  };
}

/** Seeded faults: a repeat offender, a sensor degradation, and a comms blackout. */
function coreFaults(): readonly FaultInjection[] {
  return [
    {
      robotId: "greenworks-mower-01",
      ts: "2026-03-16T10:15:00.000Z",
      type: "STUCK",
      durationMinutes: 30,
    },
    {
      robotId: "navimow-mower-02",
      ts: "2026-03-16T12:20:00.000Z",
      type: "SENSOR_DEGRADED",
      durationMinutes: 25,
    },
    {
      robotId: "greenworks-mower-01",
      ts: "2026-03-16T13:40:00.000Z",
      type: "STUCK",
      durationMinutes: 20,
    },
  ];
}

function coreConnectivity(): readonly ConnectivityWindow[] {
  return [
    // Midday blackout: the baseline's last-known-state dispatch keeps trying
    // the dark robot while the risk-aware planner reassigns around it.
    {
      robotId: "navimow-mower-01",
      from: "2026-03-16T09:00:00.000Z",
      until: "2026-03-16T11:00:00.000Z",
    },
    // Afternoon blackout on the repeat-offender's teammate.
    {
      robotId: "greenworks-mower-02",
      from: "2026-03-16T15:00:00.000Z",
      until: "2026-03-16T16:30:00.000Z",
    },
  ];
}

const CORE_FAULTS = coreFaults();
const CORE_CONNECTIVITY = coreConnectivity();

/** The main scenario: mixed tariffs, seeded faults, one connectivity blackout. */
export function coreMowingScenario(): SimulationScenario {
  return {
    scenarioId: "core-mowing",
    seed: 20260316,
    start: START,
    horizonMinutes: HORIZON_MINUTES,
    fleet: benchmarkFleet(),
    tasks: benchmarkTasks(),
    sites: SITES,
    localOffsetMinutes: SCENARIO_OFFSET_MINUTES,
    faultInjections: CORE_FAULTS,
    connectivityWindows: CORE_CONNECTIVITY,
    packs: [coreTariffPack()],
    homeSiteId: HOME_SITE_ID,
    objective: BENCHMARK_OBJECTIVE,
  };
}

/** Same world, sharp 08:00–17:00 peak — the off-peak-shifting scenario. */
export function peakTariffScenario(): SimulationScenario {
  return {
    ...coreMowingScenario(),
    scenarioId: "peak-tariff",
    seed: 20260317,
    packs: [peakTariffPack()],
  };
}

/** Core world plus the noise ordinance; the night jobs shift into the day. */
export function noiseOrdinanceScenario(): SimulationScenario {
  return {
    ...coreMowingScenario(),
    scenarioId: "noise-ordinance",
    seed: 20260318,
    tasks: noiseTasks(),
    packs: [coreTariffPack(), noiseOrdinancePack()],
  };
}

export function benchmarkScenarios(): readonly SimulationScenario[] {
  return [
    coreMowingScenario(),
    peakTariffScenario(),
    noiseOrdinanceScenario(),
    tariffShiftScenario(),
  ];
}
