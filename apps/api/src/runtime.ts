import type {
  ExternalConstraintPack,
  FaultEvent,
  Intervention,
  Robot,
  TelemetrySample,
} from "@fleetos/core-schema";
import {
  GreenworksMowerAdapter,
  HusqvarnaMowerAdapter,
  NavimowMowerAdapter,
  ScrubberAdapter,
} from "@fleetos/adapters-sdk";
import type { CommandTicket, RobotAdapter, Unsubscribe } from "@fleetos/adapters-sdk";
import { createWorldModel, systemClock } from "@fleetos/world-model";
import type { WorldClock } from "@fleetos/world-model";
import type { DigitalShadowSlice, FleetStateEstimate, FleetWorldModel } from "@fleetos/world-model";
import { createFleetHealthEngine } from "@fleetos/fleet-health";
import type { ExceptionRecord, FleetHealthEngine } from "@fleetos/fleet-health";
import {
  envelopesFromPlan,
  normalizeObjective,
  planSchedule,
  ruleBasedBaseline,
  assemblePlan,
} from "@fleetos/scheduler";
import type {
  AssignedEnvelope,
  SchedulingContext,
  SchedulerPlan,
  SchedulableTask,
  SchedulingObjective,
} from "@fleetos/scheduler";
import { createPackLibrary } from "@fleetos/constraints";
import type { PackLibrary } from "@fleetos/constraints";
import { createDeviceAgent } from "@fleetos/device-agents";
import type {
  DeviceAgent,
  RecoveryDecision,
  RecoveryResolution,
  ReplanProposal,
  ReplanReview,
} from "@fleetos/device-agents";

import { ApiError } from "./errors.js";
import type { ApiOptions } from "./config.js";
import { minimizeTelemetrySample, MinimizationError } from "./minimization.js";
import { FleetStore } from "./store/sqlite.js";
import type { PlanRow, ProposalRow, TaskRow } from "./store/sqlite.js";

/**
 * The runtime wiring: adapters → ingest pipelines (minimize, residency-check,
 * persist, engine, shadow), fleet-health engine, world model, per-device
 * agents, pack library, and plan-commit machinery. Routes are thin HTTP
 * skins over this class; every rule stated here is testable through the API.
 */

export interface TelemetryIngestOutcome {
  readonly sample: TelemetrySample;
  readonly droppedFields: readonly string[];
  readonly admitted: boolean;
  readonly linkRestored: boolean;
  readonly region: string;
}

export interface DiagnosisRecord {
  readonly faultId: string;
  readonly diagnosisId: string;
  readonly robotId: string;
  readonly severity: string;
  readonly suggestedRecovery: string;
  readonly rationale: string;
}

export interface RecoveryRequest {
  readonly operatorId: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
}

export interface RecoveryDecisionOutcome {
  readonly decision: RecoveryDecision;
  readonly resolution: RecoveryResolution | null;
  readonly intervention: Intervention;
  readonly ticket: CommandTicket | null;
}

export interface ProposeResult {
  readonly proposal: ReplanProposal;
  readonly review: ReplanReview;
  readonly row: ProposalRow;
}

export class FleetOsRuntime {
  readonly store: FleetStore;
  readonly engine: FleetHealthEngine;
  readonly world: FleetWorldModel;
  readonly clock: WorldClock;
  readonly adapters: readonly RobotAdapter[];
  readonly agents: ReadonlyMap<string, DeviceAgent>;
  readonly localOffsetMinutes: number;

  private readonly allowedRegions: ReadonlySet<string>;
  private packLibrary: PackLibrary | null = null;
  private readonly droppedFieldCounts = new Map<string, Map<string, number>>();
  private readonly diagnosisByFault = new Map<string, DiagnosisRecord>();
  private readonly subscriptions: readonly Unsubscribe[];
  private disposed = false;

  private constructor(
    private readonly options: ApiOptions,
    store: FleetStore,
    robots: readonly Robot[],
  ) {
    this.store = store;
    this.clock = options.clock ?? systemClock();
    this.localOffsetMinutes = options.localOffsetMinutes ?? 0;
    this.allowedRegions = new Set(options.residency.allowedRegions);

    this.engine = createFleetHealthEngine({ clock: this.clock, audit: store.audit });

    // Adapters: caller-provided or the four OEM simulators (three first-batch
    // mowers + one next-category scrubber, per the approved spec).
    this.adapters = options.adapters ?? [
      new GreenworksMowerAdapter(),
      new NavimowMowerAdapter(),
      new HusqvarnaMowerAdapter(),
      new ScrubberAdapter(),
    ];
    if (robots.length === 0) {
      throw new ApiError(500, "CONFIG_INVALID", "no robots registered by the bound adapters");
    }
    for (const robot of robots) {
      store.putRobot(robot);
    }

    // Constraint packs: approved, currently-effective versions only.
    this.rebuildPackLibrary();

    this.world = createWorldModel({
      robots,
      clock: this.clock,
      constraintPacks: (instant) => this.effectivePacks(instant),
    });

    // One agent per device, grounded in the audit trail (spec agentic ops).
    const agents = new Map<string, DeviceAgent>();
    for (const robot of robots) {
      agents.set(
        robot.robotId,
        createDeviceAgent({
          robot,
          audit: store.audit,
          clock: this.clock,
          localOffsetMinutes: this.localOffsetMinutes,
        }),
      );
    }
    this.agents = agents;

    // Bind adapter streams through the shared ingest pipeline.
    const unsubscribes: Unsubscribe[] = [];
    for (const adapter of this.adapters) {
      unsubscribes.push(
        adapter.subscribeTelemetry((sample) => {
          this.ingestTelemetryPayload(sample).catch((error) => {
            if (error instanceof MinimizationError) {
              return; // adapter streams emit conformant samples; nothing to do
            }
            throw error;
          });
        }),
      );
      unsubscribes.push(
        adapter.subscribeFaults((fault) => {
          this.ingestFaultEvent(fault);
        }),
      );
    }
    this.subscriptions = unsubscribes;
  }

  /**
   * Async construction: collects robots from the adapters (the one await the
   * sync constructor cannot do), binds sites, and connects adapters.
   */
  static async create(options: ApiOptions): Promise<FleetOsRuntime> {
    const probeAdapters = options.adapters ?? [
      new GreenworksMowerAdapter(),
      new NavimowMowerAdapter(),
      new HusqvarnaMowerAdapter(),
      new ScrubberAdapter(),
    ];
    for (const adapter of probeAdapters) {
      if ((await adapter.healthCheck()).state !== "connected") {
        await adapter.connect();
      }
    }
    const robots: Robot[] = [];
    for (const adapter of probeAdapters) {
      robots.push(...(await adapter.listRobots()));
    }
    const store = new FleetStore(options.dataDir);
    for (const site of options.sites ?? []) {
      store.putSite(site);
    }
    // Hand the probed, connected adapter instances to the runtime — a fresh
    // default set would silently discard the connections just established.
    return new FleetOsRuntime({ ...options, adapters: probeAdapters }, store, robots);
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    for (const adapter of this.adapters) {
      await adapter.disconnect().catch(() => undefined);
    }
    this.store.close();
  }

  // ── Ingest pipelines ────────────────────────────────────────────────────

  /**
   * The single telemetry path — adapter streams and POST /telemetry/ingest
   * both flow through here: minimize against the robot's allowlist, enforce
   * residency, persist to the region's own database, then feed the
   * fleet-health engine and the digital shadow.
   */
  async ingestTelemetryPayload(raw: unknown): Promise<TelemetryIngestOutcome> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new MinimizationError("TELEMETRY_INVALID", "telemetry payload must be a JSON object", []);
    }
    const payload = raw as Record<string, unknown>;
    const robotId = payload["robotId"];
    if (typeof robotId !== "string") {
      throw new MinimizationError("TELEMETRY_INVALID", "telemetry payload has no string robotId", [
        "robotId",
      ]);
    }
    const robot = this.requireRobot(robotId);

    const region = robot.compliance.dataResidency.telemetryRegion;
    this.assertRegionAllowed(region);

    const { sample, droppedFields } = minimizeTelemetrySample(payload, robot);
    if (droppedFields.length > 0) {
      this.countDropped(robotId, droppedFields);
    }

    this.store.telemetryStore(region).insert(sample, droppedFields);

    const result = this.engine.ingestTelemetry(sample);
    if (result.admitted) {
      this.world.ingest(sample); // excluded samples never reach the shadow
    }
    return { sample, droppedFields, admitted: result.admitted, linkRestored: result.linkRestored, region };
  }

  /** The single fault path — adapter streams and (later) manual injection. */
  ingestFaultEvent(fault: FaultEvent): { exception: ExceptionRecord | null; diagnosis: DiagnosisRecord | null } {
    const result = this.engine.ingestFault(fault);

    let diagnosis: DiagnosisRecord | null = null;
    const agent = this.agents.get(fault.robotId);
    if (agent !== undefined) {
      const agentDiagnosis = agent.reportFault(fault); // audited inside the agent
      this.engine.recordDiagnosis(agentDiagnosis);
      diagnosis = {
        faultId: fault.faultId,
        diagnosisId: agentDiagnosis.diagnosisId,
        robotId: fault.robotId,
        severity: agentDiagnosis.severity,
        suggestedRecovery: agentDiagnosis.suggestedRecovery.kind,
        rationale: agentDiagnosis.suggestedRecovery.rationale,
      };
      this.diagnosisByFault.set(fault.faultId, diagnosis);
    }

    this.world.ingest(fault);
    return { exception: result.exception, diagnosis };
  }

  // ── Residency ───────────────────────────────────────────────────────────

  assertRegionAllowed(region: string): void {
    if (!this.allowedRegions.has(region)) {
      throw new ApiError(
        422,
        "REGION_NOT_PERMITTED",
        `telemetry region "${region}" is not in the deployment's residency configuration — ingest rejected, nothing persisted`,
      );
    }
  }

  allowedRegionList(): readonly string[] {
    return [...this.allowedRegions].sort();
  }

  minimizationSummary(): ReadonlyArray<{ robotId: string; fields: Readonly<Record<string, number>>; total: number }> {
    return [...this.droppedFieldCounts.entries()]
      .map(([robotId, fields]) => ({
        robotId,
        fields: Object.fromEntries(fields) as Record<string, number>,
        total: [...fields.values()].reduce((sum, n) => sum + n, 0),
      }))
      .sort((a, b) => (a.robotId < b.robotId ? -1 : 1));
  }

  private countDropped(robotId: string, fields: readonly string[]): void {
    let counts = this.droppedFieldCounts.get(robotId);
    if (counts === undefined) {
      counts = new Map<string, number>();
      this.droppedFieldCounts.set(robotId, counts);
    }
    for (const field of fields) {
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
  }

  // ── Constraint packs ────────────────────────────────────────────────────

  /** Rebuilds the library from approved stored versions (approval gate). */
  rebuildPackLibrary(): void {
    const approved = this.store
      .packVersions()
      .filter((version) => version.approved)
      .map((version) =>
        version.effectiveUntil === null
          ? { pack: version.pack, effectiveFrom: version.effectiveFrom }
          : { pack: version.pack, effectiveFrom: version.effectiveFrom, effectiveUntil: version.effectiveUntil },
      );
    const library = createPackLibrary(approved);
    this.packLibrary = library;
  }

  /** Packs in force at an instant — the world model's PackSource. */
  effectivePacks(instant: string): readonly ExternalConstraintPack[] {
    return this.packLibrary?.packsAt(instant) ?? [];
  }

  // ── Planning ────────────────────────────────────────────────────────────

  /** Tasks the planner may be offered: pending/scheduled, not held, not terminal. */
  planOfferableTasks(): readonly SchedulableTask[] {
    const held = new Set(this.engine.heldTasks());
    return this.store
      .tasks()
      .filter((task) => task.status !== "completed" && task.status !== "cancelled" && task.status !== "held")
      .filter((task) => !held.has(task.taskId))
      .map(taskToSchedulable);
  }

  /** All stored tasks as SchedulableTask — envelope building needs every record. */
  schedulableTasks(): readonly SchedulableTask[] {
    return this.store.tasks().map(taskToSchedulable);
  }

  /** The scheduling context the plan will run against: shadow + geography + site-time policy. */
  schedulingContext(): SchedulingContext {
    const sites = new Map<string, { readonly lat: number; readonly lon: number }>();
    for (const site of this.store.sites()) {
      sites.set(site.siteId, { lat: site.lat, lon: site.lon });
    }
    return {
      estimate: this.world.snapshot(),
      sites,
      localOffsetMinutes: this.localOffsetMinutes,
    };
  }

  computePlan(scheduler: "risk-aware" | "baseline", objective: SchedulingObjective): SchedulerPlan {
    const fleet = this.store.robots();
    const tasks = this.planOfferableTasks();
    const context = this.schedulingContext();
    const packs = this.effectivePacks(this.clock.now());
    return scheduler === "risk-aware"
      ? planSchedule(fleet, tasks, context, objective, packs)
      : ruleBasedBaseline(fleet, tasks, context, objective, packs);
  }

  /** Persists a plan as committed and fans out assignments (engine + shadow + envelopes). */
  commitPlan(plan: SchedulerPlan, objective: SchedulingObjective): PlanRow {
    const now = this.clock.now();
    const previous = this.store.committedPlan();
    if (previous !== null) {
      this.store.setPlanStatus(previous.planId, "superseded", null);
    }
    const row: PlanRow = {
      planId: plan.plan.planId,
      plannerTag: plan.plan.planId,
      status: "committed",
      createdAt: plan.plan.createdAt,
      committedAt: now,
      plan,
      objective,
    };
    this.store.putPlan(row);

    for (const entry of plan.plan.assignments) {
      this.engine.assignTask(entry.robotId, entry.taskId);
    }
    const firstPerRobot = new Map<string, (typeof plan.plan.assignments)[number]>();
    for (const entry of plan.plan.assignments) {
      const existing = firstPerRobot.get(entry.robotId);
      if (existing === undefined || entry.startAt < existing.startAt) {
        firstPerRobot.set(entry.robotId, entry);
      }
    }
    for (const [robotId, first] of firstPerRobot) {
      this.world.assignTask(robotId, first.taskId);
      const task = this.store.task(first.taskId);
      if (task !== null) {
        this.world.assignSite(robotId, task.siteId);
      }
    }

    const envelopes = envelopesFromPlan(plan, { batteryReserveFloorPct: objective.batteryReserveFloorPct }, this.schedulableTasks());
    for (const envelope of envelopes) {
      this.store.putEnvelope({ envelopeId: envelope.envelopeId, planId: plan.plan.planId, robotId: envelope.robotId, envelope });
    }
    return row;
  }

  envelopeFor(robotId: string): AssignedEnvelope | null {
    const committed = this.store.committedPlan();
    if (committed === null) {
      return null;
    }
    return this.store.envelopes(committed.planId).find((e) => e.robotId === robotId)?.envelope ?? null;
  }

  // ── Device-agent flows ──────────────────────────────────────────────────

  /** Re-grounds the agent and asks its policy for a bounded local replan. */
  generateProposal(robotId: string): ProposeResult | null {
    const agent = this.requireAgent(robotId);
    const slice = this.world.sliceFor(robotId);
    if (slice === null) {
      throw new ApiError(409, "SHADOW_EMPTY", `robot "${robotId}" has no digital-shadow state yet`);
    }
    const envelope = this.envelopeFor(robotId);
    const packs = this.world.activePacks(robotId);
    agent.observe(slice, envelope, packs);
    const proposed = agent.proposeLocalReplan(); // policy + review + audit inside the agent
    if (proposed === null) {
      return null;
    }
    const row: ProposalRow = {
      proposalId: proposed.proposal.proposalId,
      robotId,
      status: "pending",
      createdAt: proposed.proposal.createdAt,
      decidedAt: null,
      decisionReason: null,
      proposal: proposed.proposal,
      review: proposed.review,
    };
    this.store.putProposal(row);
    return { proposal: proposed.proposal, review: proposed.review, row };
  }

  /**
   * Approves a pending proposal: the agent re-reviews it against the
   * envelope in force (a stale proposal against a replaced plan is rejected
   * here), then the scheduler applies the bounded move as a committed
   * agent-revision plan.
   */
  approveProposal(proposalId: string, operatorId: string, reason: string): { plan: PlanRow; proposal: ProposalRow } {
    const row = this.store.proposal(proposalId);
    if (row === null) {
      throw new ApiError(404, "PROPOSAL_UNKNOWN", `no agent proposal "${proposalId}"`);
    }
    if (row.status !== "pending") {
      throw new ApiError(409, "PROPOSAL_ALREADY_DECIDED", `proposal "${proposalId}" is already ${row.status}`);
    }
    const robotId = row.robotId;
    const agent = this.requireAgent(robotId);
    const slice = this.world.sliceFor(robotId);
    if (slice === null) {
      throw new ApiError(409, "SHADOW_EMPTY", `robot "${robotId}" has no digital-shadow state yet`);
    }
    agent.observe(slice, this.envelopeFor(robotId), this.world.activePacks(robotId));
    const review = agent.reviewProposal(row.proposal);
    if (!review.accepted) {
      throw new ApiError(
        409,
        "PROPOSAL_REJECTED_AT_REVIEW",
        `proposal "${proposalId}" no longer matches the envelope in force: ${review.code} — ${review.message}`,
      );
    }

    const committed = this.store.committedPlan();
    if (committed === null) {
      throw new ApiError(409, "NO_COMMITTED_PLAN", "no committed plan to revise");
    }
    const assignments = [...committed.plan.plan.assignments];
    const revised = applyProposalToAssignments(assignments, row.proposal);
    const revisedPlan = assemblePlan({
      plannerTag: "agent-revision",
      createdAt: this.clock.now(),
      assignments: revised,
      projections: committed.plan.plan.projected,
      charging: committed.plan.charging,
      unassigned: committed.plan.unassigned,
    });
    const planRow = this.commitPlan(revisedPlan, committed.objective);

    const updatedRow: ProposalRow = {
      ...row,
      status: "approved",
      decidedAt: this.clock.now(),
      decisionReason: reason,
    };
    this.store.putProposal(updatedRow);
    return { plan: planRow, proposal: updatedRow };
  }

  /** Rejects a pending proposal — a recorded human intervention, audited. */
  rejectProposal(proposalId: string, operatorId: string, reason: string): ProposalRow {
    const row = this.store.proposal(proposalId);
    if (row === null) {
      throw new ApiError(404, "PROPOSAL_UNKNOWN", `no agent proposal "${proposalId}"`);
    }
    if (row.status !== "pending") {
      throw new ApiError(409, "PROPOSAL_ALREADY_DECIDED", `proposal "${proposalId}" is already ${row.status}`);
    }
    this.engine.recordIntervention({
      robotId: row.robotId,
      kind: "reject-proposal",
      operatorId,
      reason,
      ...(this.store.committedPlan()?.planId
        ? { planId: this.store.committedPlan()!.planId }
        : {}),
    }); // audited by the engine; the proposal row is the operator-facing state
    const updatedRow: ProposalRow = {
      ...row,
      status: "rejected",
      decidedAt: this.clock.now(),
      decisionReason: reason,
    };
    this.store.putProposal(updatedRow);
    return updatedRow;
  }

  // ── Recovery decisions (exception → human decision → audited command) ───

  async decideRecovery(exceptionId: string, input: RecoveryRequest): Promise<RecoveryDecisionOutcome> {
    const exception = this.engine.exception(exceptionId); // 404 via FleetHealthError mapping
    const diagnosis = this.diagnosisByFault.get(exception.faultId);
    if (diagnosis === undefined) {
      throw new ApiError(
        409,
        "DIAGNOSIS_UNKNOWN",
        `the fault behind exception "${exceptionId}" has no device-agent diagnosis — no recovery path exists`,
      );
    }
    const agent = this.requireAgent(exception.robotId);
    const decision = agent.decideRecovery({ ...input, diagnosisId: diagnosis.diagnosisId }); // audited inside the agent

    let resolution: RecoveryResolution | null = null;
    let ticket: CommandTicket | null = null;
    if (input.decision === "approve") {
      resolution = agent.issueRecoveryCommand(diagnosis.diagnosisId);
      if (resolution.kind === "command") {
        const command = resolution.command;
        ticket = await this.adapterForRobot(exception.robotId).sendCommand({
          robotId: command.robotId,
          command: command.permission,
        });
      }
    }
    const intervention = this.engine.recordIntervention({
      robotId: exception.robotId,
      kind: input.decision === "approve" ? "approve-recovery" : "reject-proposal",
      operatorId: input.operatorId,
      reason: input.reason,
      ...(exception.taskId ? { taskId: exception.taskId } : {}),
      ...(this.store.committedPlan()?.planId
        ? { planId: this.store.committedPlan()!.planId }
        : {}),
    });
    return { decision, resolution, intervention, ticket };
  }

  // ── Commands & lookups ──────────────────────────────────────────────────

  adapterForRobot(robotId: string): RobotAdapter {
    const robot = this.requireRobot(robotId);
    const adapter = this.adapters.find((a) => a.vendor === robot.vendor);
    if (adapter === undefined) {
      throw new ApiError(409, "ADAPTER_UNKNOWN", `no adapter bound for vendor "${robot.vendor}"`);
    }
    return adapter;
  }

  requireRobot(robotId: string): Robot {
    const robot = this.store.robot(robotId);
    if (robot === null) {
      throw new ApiError(404, "ROBOT_UNKNOWN", `no robot "${robotId}" in the fleet`);
    }
    return robot;
  }

  requireAgent(robotId: string): DeviceAgent {
    const agent = this.agents.get(robotId);
    if (agent === undefined) {
      throw new ApiError(404, "AGENT_UNKNOWN", `no device agent for robot "${robotId}"`);
    }
    return agent;
  }

  objective(): SchedulingObjective {
    return normalizeObjective(this.options.objective ?? {});
  }

  healthSummary(): { healthy: number; degraded: number; unknown: number; degradedRobots: readonly string[] } {
    const degraded = [...this.engine.degradedRobots()].sort();
    const robots = this.store.robots();
    let healthy = 0;
    let unknown = 0;
    for (const robot of robots) {
      const state = this.engine.healthOf(robot.robotId);
      if (state === "healthy") healthy += 1;
      if (state === "unknown") unknown += 1;
    }
    return { healthy, degraded: degraded.length, unknown, degradedRobots: degraded };
  }

  fleetView(): ReadonlyArray<RobotView> {
    const estimate: FleetStateEstimate = this.world.snapshot();
    const slices = new Map<string, DigitalShadowSlice>();
    for (const slice of estimate.robots) {
      slices.set(slice.robotId, slice);
    }
    return this.store.robots().map((robot) => ({
      robot,
      shadow: slices.get(robot.robotId) ?? null,
      confidence: this.world.confidence(robot.robotId),
      health: this.engine.healthOf(robot.robotId),
    }));
  }
}

/** One robot's API view: the capability record plus live shadow, confidence, and health. */
export interface RobotView {
  readonly robot: Robot;
  readonly shadow: DigitalShadowSlice | null;
  readonly confidence: number;
  readonly health: string;
}

function taskToSchedulable(task: TaskRow): SchedulableTask {
  return { ...task.record, estMinutes: task.estMinutes };
}

/** The only two bounded moves a proposal may make to the committed plan. */
function applyProposalToAssignments(
  assignments: SchedulerPlan["plan"]["assignments"],
  proposal: ReplanProposal,
): SchedulerPlan["plan"]["assignments"] {
  if (proposal.kind === "shift-start") {
    const target = assignments.find((a) => a.taskId === proposal.taskId);
    if (target === undefined) {
      throw new ApiError(
        409,
        "PROPOSAL_NOT_APPLICABLE",
        `proposal "${proposal.proposalId}" shifts task "${proposal.taskId}", which the committed plan no longer assigns`,
      );
    }
    return assignments.map((a) => (a === target ? { ...a, startAt: proposal.newStartAt } : a));
  }
  const a = assignments.find((entry) => entry.taskId === proposal.taskIdA);
  const b = assignments.find((entry) => entry.taskId === proposal.taskIdB);
  if (a === undefined || b === undefined) {
    throw new ApiError(
      409,
      "PROPOSAL_NOT_APPLICABLE",
      `proposal "${proposal.proposalId}" swaps tasks the committed plan no longer assigns`,
    );
  }
  return assignments.map((entry) => {
    if (entry === a) return { ...entry, startAt: b.startAt };
    if (entry === b) return { ...entry, startAt: a.startAt };
    return entry;
  });
}

/** Async factory — the entry point apps and tests use to boot the runtime. */
export async function createFleetOsRuntime(options: ApiOptions): Promise<FleetOsRuntime> {
  return FleetOsRuntime.create(options);
}
