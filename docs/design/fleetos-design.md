# FleetOS — System Design

**Circunar Inc. · FleetOS MVP · Design of record**

**Status:** approved-spec design, simulator-first MVP. This document is the technical source of truth for the MVP's contracts and layers; the market and business framing live in [docs/plan/product-plan.md](../plan/product-plan.md). Where the concept document (`02_Circunar_RaaS_Fleet_OS.docx`) makes a claim this design implements, it is cited as docx §N.

**Summary.** FleetOS is a five-layer system. Adapters normalize heterogeneous robots into a capability-typed fleet; a world-model layer maintains a live digital shadow of fleet state with calibrated confidence; the scheduling core assigns and sequences work under uncertainty against external constraint packs; fleet health watches for faults and drives escalation; the operator console gives humans supervision, intervention, and compliance visibility. The MVP runs entirely against in-process simulators behind the same adapter contracts a physical OEM integration would implement. Per-device agents — derived from the digital-twin layer, one per robot — add bounded, audited, human-supervised local autonomy.

**Non-goals (guardrail).** No physical robot is driven by anything in MVP scope. No teleoperation, no low-latency remote video, no safety-certified remote driving — the local safety controller stays authoritative (docx §10). No billing, mobile apps, or marketplace. The remote intervention surface is pause/resume/reassign only.

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Operator console (apps/console)                            │
│  fleet map/list · schedule board · exception queue ·        │
│  agent-proposal review · compliance surfacing               │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (apps/api — Fastify, SQLite)
┌──────────────────────────┴──────────────────────────────────┐
│  Scheduling core (packages/scheduler)                       │
│  risk-aware planner · rule-based baseline · benchmark       │
│  harness — all constraint-pack aware                        │
├─────────────────────────────────────────────────────────────┤
│  World model (packages/world-model)      Device agents      │
│  digital shadow · per-robot           (packages/            │
│  confidence · prediction seam         device-agents)        │
├─────────────────────────────────────────────────────────────┤
│  Fleet health (packages/fleet-health)                       │
│  fault classification · exception queue · audit trail ·     │
│  degraded mode                                              │
├─────────────────────────────────────────────────────────────┤
│  Constraints (packages/constraints)                         │
│  tariff · weather · site rules · SLA — versioned packs      │
├─────────────────────────────────────────────────────────────┤
│  Adapters SDK (packages/adapters-sdk)                       │
│  4 simulators: Greenworks · Navimow · Husqvarna · scrubber  │
├─────────────────────────────────────────────────────────────┤
│  Core schema (packages/core-schema)                         │
│  capability record · task/telemetry/fault · compliance      │
└─────────────────────────────────────────────────────────────┘
```

Three mower simulators (Greenworks, 九号/Navimow, Husqvarna — founder-confirmed first physical batch, 2026-11-01) plus one next-category scrubber simulator sit behind one adapter contract. The world model feeds confidence-aware scheduling and fleet health; the console supervises and intervenes.

## 2. The capability ontology (the normalization contract)

Every robot — simulator now, physical OEM later — is described by one versioned capability record. The scheduler reads capabilities, never vendor specifics. This is the schema the whole system hangs on:

```typescript
// packages/core-schema/src/capability.ts — versioned, additive-only evolution
export interface RobotCapabilityRecord {
  readonly schemaVersion: 1;
  readonly robotId: string; // fleet-unique
  readonly vendor: string; // "mowersim" | "scrubbersim" | ...
  readonly model: string;
  readonly firmwareVersion: string; // drives compatibility checks
  readonly kind: "mower" | "scrubber" | "inspection-rover";
  readonly capabilities: {
    readonly taskTypes: ReadonlyArray<"mow" | "scrub" | "inspect">;
    readonly maxSlopeDeg: number;
    readonly batteryWh: number;
    readonly nominalPowerWhPerHour: number;
    readonly chargeHours: [number, number]; // 10%→100% range
    readonly weatherTolerance: ReadonlyArray<"clear" | "light-rain" | "wet-grass">;
    readonly noGoZones: boolean; // can it honor dynamic geofences?
    readonly remoteResume: boolean; // can it resume without on-site human?
  };
  readonly commands: ReadonlyArray<CommandPermission>; // explicit allow-list
  readonly confidence: number; // adapter-reported data quality 0..1
}

export type CommandPermission =
  "START_TASK" | "PAUSE" | "RESUME" | "DOCK_CHARGE" | "RETURN_HOME" | "SET_NO_GO_ZONE" | "ABORT";

// Scheduler contract: a robot is schedulable iff
//   capability.taskTypes ⊇ task.requirements
// AND command allow-list covers every command the dispatch plan will send.
```

Schema evolution is additive-only at major version 1; breaking changes bump the version and adapters declare what they speak.

## 3. The adapter SDK

One interface per direction of flow. A vendor integration implements `RobotAdapter`; FleetOS core never imports vendor code. Each simulator implements the same interface with an injected fault profile, so adapter contracts are validated in CI the way a physical integration would be:

```typescript
export interface RobotAdapter {
  readonly vendor: string;
  readonly apiVersion: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<AdapterHealth>;
  listRobots(): Promise<readonly Robot[]>;
  subscribeTelemetry(cb: (t: TelemetrySample) => void): Unsubscribe;
  // Every command returns a ticket; result arrives via telemetry or poll.
  sendCommand(cmd: RobotCommand): Promise<CommandTicket>;
  // Normalized fault taxonomy across vendors:
  // BATTERY | STUCK | SENSOR_DEGRADED | COMMS_LOST | WEATHER_HOLD | MAINTENANCE_DUE
  subscribeFaults(cb: (f: FaultEvent) => void): Unsubscribe;
  // Lifecycle stream: connecting | connected | reconnecting | degraded | disconnected
  subscribeLifecycle(cb: (e: AdapterLifecycleEvent) => void): Unsubscribe;
  pollTicket(ticketId: string): Promise<CommandTicketState>;
}

// MVP adapters: GreenworksMowerAdapter, NavimowMowerAdapter,
// HusqvarnaMowerAdapter (Open API model), ScrubberSimAdapter —
// the first three model the OEM cloud APIs of the founder-confirmed
// first physical integration targets; all four wrap in-process
// simulators whose behavior is seeded from scenario files, so
// benchmark runs are deterministic and CI-reproducible.
```

Contract discipline: a shared contract suite runs against all four adapters in CI (listRobots, telemetry subscription, command ticket flow, fault emission). If any adapter passes a test the others fail, normalization is leaky and the PR is not mergeable.

## 4. World-model layer: digital shadow with calibrated confidence

FleetOS's lead research claim is a **vendor-neutral world model** built over the normalized capability ontology: one unified probabilistic fleet state spanning OEMs, with confidence-aware planning that knows when its predictions are unreliable. This extends the 2025–26 multi-fidelity digital-twin state of the art (single-vendor or warehouse-AMR-specific today; Research stage record: Springer 2026-08-03 confidence-aware multi-fidelity DT for AMR fleets; arXiv "From Digital Twins to World Models") to heterogeneous service fleets.

The MVP ships the deterministic core of this claim — digital shadow, per-robot confidence estimation, and the prediction seam consumed by the scheduler. Learned world-model prediction is the NSF Phase I research aim, not MVP scope:

```typescript
export interface FleetWorldModel {
  // Absorbs normalized telemetry + faults into one fleet-state estimate.
  ingest(event: TelemetryEvent | FleetFault): void;
  snapshot(): FleetStateEstimate;
  // per-robot: pose class, battery
  // distribution, task progress,
  // reliability, data staleness
  // Confidence per robot/estimate: degraded telemetry lowers it, and the
  // scheduler down-weights low-confidence robots instead of trusting them.
  confidence(robotId: string): number; // 0..1, calibrated on held-out runs
  // Prediction seam: MVP uses stochastic simulation from scenario seeds;
  // Phase I replaces this with a learned world model (falsifiable swap).
  predict(horizonMinutes: number): PredictedFutures;
}

// Scheduler consumes the model, not raw vendor telemetry:
// planSchedule(fleet, tasks, worldModel.snapshot(), objective)
// Benchmark harness reports both quality deltas AND confidence-calibration
// error, so "the model knows what it doesn't know" is a measured claim.
```

Design invariant: the scheduler consumes the world model, never raw vendor telemetry. Low-confidence robots are down-weighted, not silently trusted — verified in CI by injecting stale/faulty telemetry and asserting both the confidence drop and the scheduling behavior shift.

## 5. External constraints: constraint packs and the Phase I AI seam

The scheduler's constrained optimization (a boundary-condition optimum over battery, travel, intervention, and completion costs) is the foundation. On top of it, external constraints — the things that bound operations from outside the fleet — enter as structured, versioned **constraint packs**. This follows founder direction (2026-10-31, thread record) extending the optimizer with AI-driven operations optimization under external constraints, applicable beyond mowing to energy optimization and adjacent operations domains.

**MVP — constraint packs.** Energy tariffs (price curves, demand charges → shift charging and energy-heavy work off-peak), weather windows (rain/wind/heat cutoffs), site access hours, noise ordinances, and customer SLA windows enter the same objective the scheduler already optimizes; the benchmark reports energy cost alongside completion and interventions.

```typescript
export interface ExternalConstraintPack {
  readonly packId: string;
  readonly schemaVersion: 1;
  readonly source: "tariff" | "weather" | "site-rules" | "sla" | "regulation";
  readonly appliesTo: SiteSelector; // site, robot class, time window
  readonly hard: TimeWindowConstraint[]; // e.g. noise ordinance, access hours
  readonly soft: WeightedConstraint[]; // e.g. demand charges, SLA priority
  readonly costTerms: EnergyCostCurve[]; // $/kWh curve → charging + mowing cost
  readonly provenance: {
    origin: string;
    humanApproved: boolean;
    extractedBy?: "human" | "ai-draft";
  };
}

// Scheduler consumes constraint packs in the same objective it already optimizes:
// planSchedule(fleet, tasks, worldModel.snapshot(), objective, constraintPacks)
// Benchmark adds an energy-cost axis: off-peak charging vs on-peak, measured.
```

**Phase I — AI constraint extraction & demand matching (research aim).** LLM-based pipelines analyze unstructured sources at scale — customer contracts, SLA documents, site rules, regulations, service emails and work orders — and convert them into candidate constraint packs and customer-preference weights, with human review before any constraint reaches the optimizer. This is what lets the system match customer demand to operations without humans re-keying documents, and what generalizes the optimizer to adjacent domains:

```typescript
// Phase I seam — AI drafts constraints from unstructured data, humans approve:
// draftConstraintPack(document: UnstructuredDoc): Promise<ExternalConstraintPack>
//
// extractedBy: "ai-draft", humanApproved: false until a human signs off;
// nothing reaches the optimizer unapproved. Falsifiable Phase I swap, like
// the world model's learned predictor.
```

Hard constraint precedent: the noise ordinance and site access hour packs are hard constraints — a schedule containing mowing work inside a hard window is invalid by construction, and integration tests assert it (peak-price tariff pack shifts charging off-peak; noise window excludes mowing).

## 6. Agentic operations: one agent per device

Derived from the digital-twin layer (founder direction 2026-10-31, thread record): every robot gets a **device agent** whose ground truth is that robot's slice of the digital shadow — its state, confidence, active constraint packs, and the envelope the scheduler assigned it. The scheduler stays the global coordinator; the device agent owns the device-local layer: self-diagnosis, recovery proposals, and bounded local replanning.

**MVP — deterministic policy agents.** Each device agent runs a deterministic policy with a _bounded action space_: it observes its shadow slice, classifies incoming faults with severity and a suggested recovery, and may propose local replans strictly inside its assigned envelope (order swaps within a window, timing shifts that still respect hard constraints). It never drives the robot, never exceeds its envelope, and every proposal is audited; human approval gates every recovery action. This turns fleet health from a queue humans triage into a first-pass triage the operator confirms — the intervention-reduction lever, made systematic.

```typescript
export interface DeviceAgent {
  readonly robotId: string;
  // Ground truth = this robot's slice of the digital shadow (its state,
  // confidence, active constraint packs) + the envelope the scheduler assigned.
  observe(
    slice: DigitalShadowSlice,
    envelope: AssignedEnvelope,
    packs: ExternalConstraintPack[],
  ): Promise<void>;

  // Bounded MVP autonomy — proposals only, never actions:
  reportFault(f: NormalizedFault): Promise<AgentDiagnosis>;
  // severity + suggested recovery
  proposeLocalReplan(envelope: AssignedEnvelope): Promise<ReplanProposal>;
  // ↑ rejected unless fully inside the envelope and hard-constraint-safe;
  // every proposal lands in the audit trail; recovery executes only after
  // human approval in the console, through the audited command path.

  // Phase I seam — falsifiable policy swap, like the world model's predictor:
  readonly policy: AgentPolicy; // "deterministic-v1" | "llm-reasoner" (Phase I)
}
```

**Phase I — LLM-policy agentic operations (research aim).** The deterministic policy class swaps for an LLM-based reasoner through the same typed seam: richer natural-language ops dialogue, cross-device coordination proposals, and learning from operator decisions. A falsifiable swap measured against the same benchmark.

Bounded-autonomy invariants, each test-enforced (spec D1 verification): a replan proposal outside the assigned envelope is rejected; no recovery command executes without human approval; every agent proposal appears in the audit trail.

## 7. Scheduling core

The scheduler scores candidate dispatch plans jointly over four cost terms — completion risk, battery reserve, travel time, and expected human interventions — using per-robot reliability learned from the telemetry/fault stream. The baseline is a deterministic rule-based dispatcher (nearest-available-robot, fixed battery threshold) living in the same package with the same signature. Comparison runs are scripted benchmark scenarios with seeded faults; the concept document's targets are the pass bars (docx §7):

- **≥15% improvement in on-time task completion** against the rule-based baseline.
- **≥20% fewer operator interventions per 100 robot-hours** in controlled trials.
- Performance measured **under intermittent connectivity and partial telemetry loss**.
- **3 robot interfaces represented** (MVP: four simulator adapters).

```typescript
export interface SchedulingObjective {
  readonly onTimeWeight: number;
  readonly batteryReserveFloorPct: number; // never dispatch below floor
  readonly travelCostPerHour: number;
  readonly interventionCost: number; // one human touch = expensive
}

export interface DispatchPlan {
  readonly assignments: ReadonlyArray<{
    robotId: string;
    taskId: string;
    startAt: string;
    estMinutes: number;
    riskNotes: ReadonlyArray<string>; // explainability for the operator
  }>;
  readonly projected: {
    onTimeCompletion: number; // modeled
    expectedInterventions: number;
    minBatteryReservePct: number;
  };
}

export function planSchedule(
  fleet: RobotCapabilityRecord[],
  tasks: FleetTask[],
  telemetry: TelemetrySummary, // world-model snapshot in practice
  objective: SchedulingObjective,
  constraintPacks?: ExternalConstraintPack[],
): DispatchPlan;

// Baseline lives in the same package:
// export function ruleBasedBaseline(/* same signature */): DispatchPlan;
// Benchmark harness feeds identical scenario files to both and reports
// deltas — quality (on-time, interventions), calibration error, and
// energy cost per scenario.
```

Every assignment carries `riskNotes` — plan decisions are explainable to the operator reading the schedule board, not just optimal on a number.

## 8. Fleet health & human-in-the-loop

Normalized fault events stream into `packages/fleet-health`, which classifies severity, opens an exception in the console queue, and can hold the affected tasks in `HELD` state. The end-to-end path — fault → exception → human intervention → audit trail — is test-enforced (inject a BATTERY fault; assert exception queued, PAUSE and RESUME logged, audit trail appended).

Three supporting properties:

- **Audit trail.** Every state change that affects a task or robot is appended to an append-only audit trail: operator command, system action, timestamp, plan version in effect. It doubles as the compliance evidence base (§9).
- **Degraded mode.** On adapter or telemetry loss the scheduler marks affected robots `DEGRADED`, stops relying on their telemetry for optimization, and the console shows the loss explicitly — measured per docx §7 under connectivity-loss scenarios.
- **Local safety authority.** The robot/simulator's own safety controller stays authoritative. The MVP never models remote driving; the intervention surface is pause/resume/reassign only (docx §10).

## 9. Data compliance by design

Regulatory driver: on 2026-07-28, the FCC added foreign-produced "advanced robotic devices" to its Covered List (FCC 26-50 line of action; analyzed by AnJie Broad, Research stage record). The action is place-of-production based, not entity-based: new foreign-produced models lose FCC equipment authorization, existing authorized models keep operating with firmware updates waived until at least 2029-01-01, and a conditional-approval path via DoW exists with a 2028-01-01 deadline; pending rules add supply-chain BOM disclosure and US responsible-party requirements. Autonomous commercial mowers (>2 kg, sensor-equipped, networked, self-navigating) are in scope. For an operator mixing Chinese-made (九号/Navimow) and other OEM robots, compliance is an operational property, not paperwork. Four product features follow:

1. **Per-device compliance record.** The capability record carries a compliance block: production origin, FCC authorization status, firmware-update eligibility window, and data-flow profile (which OEM cloud the telemetry traverses, through which jurisdiction). Surfaced per device in the console.
2. **Data residency & minimization.** Telemetry is stored in the operator's chosen region; the platform sends the minimum set of fields each adapter needs; cross-border OEM cloud flows are surfaced in the console, not hidden. API-level enforcement: non-minimal telemetry field sets are rejected; residency configuration is validated.
3. **Firmware-update governance.** The 2029 firmware-update waiver windows are tracked per device, so operators see which robots lose update eligibility when — and can plan replacement or conditional-approval filings.
4. **Audit trail as evidence.** The append-only audit trail (§8) doubles as the compliance and incident evidence base. Phase I adds a research-security and data-governance plan (an NSF requirement; docx §13).

Scope note (locked decision): legal review and OEM-specific compliance advice are out of scope — the product states its compliance posture; NSF documents state the posture, not legal conclusions.

## 10. Stack and repository layout

TypeScript ESM pnpm monorepo, Node ≥20, vitest, eslint — mirroring the owner's `IntentVisible` conventions so CI and review patterns carry over. `apps/api` is Fastify with SQLite persistence; `apps/console` is React (Vite). Simulation keeps everything deterministic; no external services are required to run the full benchmark.

```
packages/core-schema      capability record v1, task/telemetry/fault schemas,
                          compliance block — versioned exports
packages/adapters-sdk     RobotAdapter contract + 4 simulator adapters
packages/world-model      digital shadow, confidence, prediction seam
packages/constraints      constraint packs + typed Phase I AI-extraction seam
packages/device-agents    per-device deterministic policy agents, policy seam
packages/scheduler        risk-aware planner + rule-based baseline + benchmark
packages/fleet-health     fault classification, exception queue, audit, degraded
apps/api                  Fastify REST: fleet, tasks, schedule, exceptions,
                          interventions, benchmark; residency/minimization
apps/console              React operator console: fleet, schedule board,
                          exception queue, agent-proposal review, compliance
```

## 11. Verification

Verification lives in [docs/testing/testing-plan.md](../testing/testing-plan.md) (deliverable D3) and the approved spec's Verification section. The short form: schema round-trip tests; one identical adapter contract suite across all four simulators; world-model confidence-drop and calibration reporting; scheduler-vs-baseline benchmark with the docx §7 bars as CI gates; fault→exception→intervention→audit end-to-end; degraded-mode asserts; constraint-pack shaping and energy-cost axis; device-agent bounded-autonomy asserts; compliance enforcement tests; console demo path via agent-browser evidence against the tested head SHA.

---

_Sources: FleetOS Product Spec `art_s9VfpgZW` (approved; contracts and locked decisions); `02_Circunar_RaaS_Fleet_OS.docx` (fl_vsuFP4sL, full text extracted 2026-11-01; cited as docx §N); FCC Covered List action (2026-07-28, FCC 26-50, DA 26-786/789 — AnJie Broad analysis, Research stage record); world-model state of the art (Springer 2026-08-03 multi-fidelity DT; arXiv "From Digital Twins to World Models" — Research stage record)._
