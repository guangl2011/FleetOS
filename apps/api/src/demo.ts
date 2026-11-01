import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GreenworksMowerAdapter,
  HusqvarnaMowerAdapter,
  ManualClock,
  NavimowMowerAdapter,
  ScrubberAdapter,
} from "@fleetos/adapters-sdk";

import { buildApp } from "./app.js";

/**
 * Demo harness (spec acceptance: "operator console usable for the demo path").
 *
 * Boots the real API over the four OEM simulator adapters with a shared
 * ManualClock, seeds the operator's demo day over the public API (tasks, a
 * tariff constraint pack, benchmark runs), then keeps the fleet alive: a tick
 * loop advances sim time (one 60 s sim-minute per 20 s wall), a scripted
 * battery fault opens the first exception, and a committed-plan watcher drops
 * a WEATHER_HOLD on a mower whose assignment has not started yet — the state
 * the device agent needs to propose a bounded replan.
 *
 * Run with `pnpm --filter @fleetos/api demo`; open the console with
 * `pnpm --filter @fleetos/console dev` (Vite proxies /api to this server).
 */

const PORT = Number(process.env.FLEETOS_DEMO_PORT ?? 8737);
const BASE = `http://127.0.0.1:${PORT}`;
const OPERATOR_ID = "demo-operator";
// One 60 s sim-minute per wall minute — the simulators' tick() advances their
// clock 60 s per call, so a 60 s interval gives the operator real time between
// committing a plan and the first assignment starting.
const TICK_MS = 60_000;

const demoClock = new ManualClock(new Date().toISOString().slice(0, 19) + "Z");
const adapters = {
  greenworks: new GreenworksMowerAdapter({ clock: demoClock }),
  navimow: new NavimowMowerAdapter({ clock: demoClock }),
  husqvarna: new HusqvarnaMowerAdapter({ clock: demoClock }),
  scrubber: new ScrubberAdapter({ clock: demoClock }),
};

/** Robot-id prefix → simulator adapter, so the watcher can target one robot. */
function adapterForRobot(robotId: string): (typeof adapters)[keyof typeof adapters] {
  if (robotId.startsWith("greenworks")) return adapters.greenworks;
  if (robotId.startsWith("navimow")) return adapters.navimow;
  if (robotId.startsWith("husqvarna")) return adapters.husqvarna;
  if (robotId.startsWith("scrubber")) return adapters.scrubber;
  throw new Error(`no simulator adapter for robot "${robotId}"`);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-operator-id": OPERATOR_ID },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function hoursFrom(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

interface CreatedTask {
  readonly task: { readonly taskId: string };
}

async function seedTasks(now: string): Promise<void> {
  const mow = { taskTypes: ["mow" as const] };
  const demoTasks = [
    { taskId: "demo-task-1", kind: "mow", siteId: "site-eastside", requirements: mow, estMinutes: 90, priority: 70 },
    { taskId: "demo-task-2", kind: "mow", siteId: "site-eastside", requirements: mow, estMinutes: 60, priority: 50 },
    { taskId: "demo-task-3", kind: "mow", siteId: "site-waterfront", requirements: mow, estMinutes: 75, priority: 60 },
    { taskId: "demo-task-4", kind: "mow", siteId: "site-waterfront", requirements: mow, estMinutes: 45, priority: 40 },
    {
      taskId: "demo-task-5",
      kind: "scrub",
      siteId: "site-eastside",
      requirements: { taskTypes: ["scrub" as const] },
      estMinutes: 80,
      priority: 30,
    },
  ] as const;
  for (const task of demoTasks) {
    await call<CreatedTask>("POST", "/tasks", {
      ...task,
      // Not-before one sim-hour out: the committed plan's first (envelope)
      // assignments start with operator-scale headroom instead of at the next
      // tick, so the weather-hold proposal window is reachable at demo pace.
      window: { notBefore: hoursFrom(now, 1), notAfter: hoursFrom(now, 10) },
    });
  }
}

async function seedTariffPack(now: string): Promise<void> {
  await call("POST", "/constraint-packs", {
    pack: {
      schemaVersion: "1.0.0",
      packId: "pack-demo-tariff",
      source: "tariff",
      appliesTo: { robotKinds: ["mower"] },
      hard: [],
      soft: [],
      costTerms: [
        {
          curveId: "curve-demo",
          currency: "USD",
          points: [
            { at: now, pricePerKwh: 0.08 },
            { at: hoursFrom(now, 4), pricePerKwh: 0.42 },
            { at: hoursFrom(now, 8), pricePerKwh: 0.08 },
          ],
        },
      ],
      provenance: { origin: "demo utility tariff sheet", humanApproved: true },
    },
    effectiveFrom: now,
  });
}

interface RobotLookup {
  readonly robots: ReadonlyArray<{ readonly robot: unknown }>;
}

async function seedBenchmarkRuns(now: string): Promise<void> {
  const fleet = (await call<RobotLookup>("GET", "/fleet/robots")).robots.map((view) => view.robot);
  const scenario = (scenarioId: string, packs?: unknown[]) => ({
    scenarioId,
    seed: 42,
    start: now,
    horizonMinutes: 240,
    fleet,
    tasks: [
      {
        schemaVersion: "1.0.0",
        taskId: "bench-task-1",
        siteId: "site-eastside",
        requirements: { taskTypes: ["mow"] },
        window: { notBefore: now, notAfter: hoursFrom(now, 8) },
        priority: 60,
        status: "pending",
        estMinutes: 90,
      },
      {
        schemaVersion: "1.0.0",
        taskId: "bench-task-2",
        siteId: "site-eastside",
        requirements: { taskTypes: ["mow"] },
        window: { notBefore: now, notAfter: hoursFrom(now, 8) },
        priority: 40,
        status: "pending",
        estMinutes: 90,
      },
    ],
    sites: [
      { siteId: "site-eastside", lat: 47.6101, lon: -122.2014 },
      { siteId: "site-waterfront", lat: 47.6205, lon: -122.3493 },
    ],
    homeSiteId: "site-eastside",
    ...(packs === undefined ? {} : { packs }),
  });
  const base = await call<{ runId: string }>("POST", "/benchmarks/runs", scenario("demo-no-pack"));
  const packed = await call<{ runId: string }>("POST", "/benchmarks/runs", scenario("demo-tariff-pack", [
    // Mirror the uploaded pack so the benchmark's packed run shows the shift.
    {
      schemaVersion: "1.0.0",
      packId: "pack-bench-demo-tariff",
      source: "tariff",
      appliesTo: { robotKinds: ["mower"] },
      hard: [],
      soft: [],
      costTerms: [
        {
          curveId: "curve-bench-demo",
          currency: "USD",
          points: [
            { at: now, pricePerKwh: 0.08 },
            { at: hoursFrom(now, 4), pricePerKwh: 0.42 },
            { at: hoursFrom(now, 8), pricePerKwh: 0.08 },
          ],
        },
      ],
      provenance: { origin: "demo utility tariff sheet", humanApproved: true },
    },
  ]));
  console.log(`[demo] benchmark runs seeded: ${base.runId} (no pack), ${packed.runId} (tariff pack)`);
}

interface PlanWatch {
  readonly plan: {
    readonly planId: string;
    readonly status: string;
    // PlanRowView.plan is the SchedulerPlan; its .plan is the DispatchPlan.
    readonly plan: {
      readonly plan: {
        readonly assignments: ReadonlyArray<{ readonly robotId: string; readonly startAt: string }>;
      };
    };
  };
}

/**
 * Committed-plan watcher: once per committed plan, drop a WEATHER_HOLD on the
 * first robot whose assignment has not started — the deterministic trigger
 * for the device-agent proposal step of the demo path.
 */
let lastWeatherHeldPlanId: string | undefined;

async function watchForWeatherHoldTarget(): Promise<void> {
  const response = await fetch(`${BASE}/schedule/plans/current`);
  if (!response.ok) return; // No committed plan yet — nothing to trigger on.
  const body = (await response.json()) as PlanWatch;
  if (body.plan.status !== "committed" || body.plan.planId === lastWeatherHeldPlanId) return;
  // Target the not-yet-started assignment with the EARLIEST start. A device
  // agent shifts its envelope's first assignment (the plan's earliest task for
  // that robot), so the hold must land on that task before it begins — the
  // seeded one-hour not-before window is the operator's headroom.
  const candidates = body.plan.plan.plan.assignments
    .filter((a) => Date.parse(a.startAt) > Date.parse(demoClock.now()))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const target = candidates[0];
  if (target === undefined) return;
  adapterForRobot(target.robotId); // fails fast if the robot has no simulator adapter
  injectWeatherHold(target.robotId);
  lastWeatherHeldPlanId = body.plan.planId;
  console.log(`[demo] WEATHER_HOLD injected on ${target.robotId} (assignment starts ${target.startAt})`);
}

function injectWeatherHold(robotId: string): void {
  const note = "demo weather front";
  if (robotId.startsWith("greenworks")) return adapters.greenworks.injectVendorFault(robotId, "E04_RAIN_DELAY", note);
  if (robotId.startsWith("navimow")) return adapters.navimow.injectVendorFault(robotId, "N04_RAIN_DETECTED", note);
  if (robotId.startsWith("husqvarna")) return adapters.husqvarna.injectVendorFault(robotId, "H04_WEATHER_TIMER", note);
  if (robotId.startsWith("scrubber")) return adapters.scrubber.injectVendorFault(robotId, "S04_OUTDOOR_HOLD", note);
  throw new Error(`no weather code for robot "${robotId}"`);
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "fleetos-demo-"));
  const api = await buildApp({
    dataDir,
    residency: { allowedRegions: ["us-west-2"] },
    sites: [
      { siteId: "site-eastside", name: "Eastside Campus", lat: 47.6101, lon: -122.2014 },
      { siteId: "site-waterfront", name: "Waterfront Turf", lat: 47.6205, lon: -122.3493 },
    ],
    adapters: [adapters.greenworks, adapters.navimow, adapters.husqvarna, adapters.scrubber],
    clock: demoClock,
  });
  await api.app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[demo] FleetOS API listening on ${BASE} (data dir ${dataDir})`);

  const now = demoClock.now();
  await seedTasks(now);
  await seedTariffPack(now);
  await seedBenchmarkRuns(now);
  console.log("[demo] seeded: 5 tasks, tariff pack, 2 benchmark runs");

  // One battery fault, latched before the first tick so the faulted status
  // poll flows through telemetry immediately — the operator's first
  // exception is waiting in the queue when the console opens.
  adapters.greenworks.injectVendorFault("greenworks-mower-01", "E01_BATTERY_LOW", "demo battery exception");
  console.log("[demo] battery fault injected on greenworks-mower-01");

  // One tick before the loop starts: telemetry must exist the moment an
  // operator opens the console, or the world-model snapshot is empty and the
  // planner has no robot slices to score (all tasks land unassigned).
  for (const adapter of Object.values(adapters)) adapter.tick();
  console.log("[demo] initial simulator tick done — shadow populated");

  const ticker = setInterval(() => {
    for (const adapter of Object.values(adapters)) adapter.tick();
  }, TICK_MS);
  const watcher = setInterval(() => {
    watchForWeatherHoldTarget().catch((error: unknown) => {
      console.error("[demo] weather-hold watcher failed:", error);
    });
  }, 5_000);

  const shutdown = (): void => {
    clearInterval(ticker);
    clearInterval(watcher);
    void api.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`
[demo] FleetOS operator demo ready on ${BASE}
[demo] console: pnpm --filter @fleetos/console dev  (then open http://localhost:5173)
[demo] path: 1) watch the fleet tick  2) acknowledge the battery exception
             3) generate + commit a schedule  4) request the weather-hold
             proposal  5) approve or reject it`);
}

main().catch((error: unknown) => {
  console.error("[demo] failed to start:", error);
  process.exitCode = 1;
});
