import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { CommandPermission, ExternalConstraintPack, FleetTask, Robot } from "@fleetos/core-schema";
import { ExternalConstraintPackSchema, FleetTaskSchema, RobotSchema } from "@fleetos/core-schema";
import { runSimulation } from "@fleetos/scheduler";
import type {
  RunMetrics,
  SchedulerPlan,
  SchedulableTask,
  SimulationScenario,
  SchedulingObjective,
} from "@fleetos/scheduler";
import { planSchedule, ruleBasedBaseline } from "@fleetos/scheduler";
import { createPackLibrary } from "@fleetos/constraints";

import { ApiError } from "./errors.js";
import type { FleetOsRuntime, RecoveryDecisionOutcome } from "./runtime.js";
import type { PlanRow } from "./store/sqlite.js";

/**
 * The HTTP surface. Handlers stay thin: validate input with zod, call the
 * runtime, shape the response. Every state-changing route is audited —
 * either by the audit hook (operator actions with no domain-specific audit
 * of their own) or by the domain itself (engine interventions, agent
 * decisions), marked `serviceAudited` so the hook does not double-append.
 */

type AuditSubjectType = "robot" | "task" | "plan" | "exception" | "agent-proposal" | "constraint-pack";

interface AuditSpec {
  readonly action: string;
  readonly subjectType: AuditSubjectType;
  /** Response-body field (dotted path) carrying the subject id. */
  readonly subjectIdField?: string;
  /** Request-body field carrying the subject id (used when the response has none). */
  readonly requestSubjectField?: string;
  /** The domain already appended the audit entry — skip the hook append. */
  readonly serviceAudited?: boolean;
}

interface RouteConfig {
  readonly audit?: AuditSpec;
  /** Mutating route: x-operator-id header is required (400 without it). */
  readonly requiresOperator?: boolean;
}

const OPERATOR_HEADER = "x-operator-id";

function operatorId(request: FastifyRequest): string {
  const header = request.headers[OPERATOR_HEADER];
  return typeof header === "string" && header.length > 0 ? header : "system";
}

function requireOperator(request: FastifyRequest): string {
  const header = request.headers[OPERATOR_HEADER];
  if (typeof header !== "string" || header.length === 0) {
    throw new ApiError(400, "OPERATOR_ID_REQUIRED", `mutating requests require the ${OPERATOR_HEADER} header`);
  }
  return header;
}

/** Reads a dotted path off a JSON value; undefined when the path is missing. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Parses a JSON value with zod, mapping failures to 400 VALIDATION. */
function parseValue<T>(value: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION", `request input failed validation: ${parsed.error.message}`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function parseBody<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  return parseValue(request.body, schema);
}

function parseQuery<T extends Record<string, unknown>>(request: FastifyRequest, schema: z.ZodType<T>): T {
  return parseValue(request.query ?? {}, schema);
}

function parseParams<T extends Record<string, unknown>>(request: FastifyRequest, schema: z.ZodType<T>): T {
  return parseValue(request.params ?? {}, schema);
}

// ── Request-body schemas ──────────────────────────────────────────────────

const TaskTypeSchema = z.enum(["mow", "scrub", "inspect"]);
const CreateTaskSchema = z.strictObject({
  taskId: z.string().min(1).max(128).optional(),
  kind: TaskTypeSchema,
  siteId: z.string().min(1).max(128),
  requirements: z.strictObject({ taskTypes: z.array(TaskTypeSchema).min(1) }),
  window: z.strictObject({ notBefore: z.string().min(1), notAfter: z.string().min(1) }),
  priority: z.number().int().min(1).max(100).optional(),
  estMinutes: z.number().positive().max(24 * 60),
});
const TaskStatusPatchSchema = z.strictObject({
  // "held" and "in-progress" are runtime states; the operator PATCHes the other four.
  status: z.enum(["pending", "scheduled", "completed", "cancelled"]),
});
const ReprioritizeSchema = z.strictObject({ priority: z.number().int().min(1).max(100) });
const PlanRequestSchema = z.strictObject({
  scheduler: z.enum(["risk-aware", "baseline"]).optional(),
});
const ReasonSchema = z.strictObject({ reason: z.string().min(1).max(2000) });
const RecoveryDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(2000),
});
const InterventionSchema = z.strictObject({
  robotId: z.string().min(1).max(128),
  kind: z.enum(["pause", "resume", "reassign"]),
  reason: z.string().min(1).max(2000),
  taskId: z.string().min(1).max(128).optional(),
});
const GenerateProposalSchema = z.strictObject({ robotId: z.string().min(1).max(128) });
const ResidencyPatchSchema = z.strictObject({
  telemetryRegion: z.string().max(64).optional(),
  allowCrossBorderTelemetry: z.boolean().optional(),
});
const PackUploadSchema = z.strictObject({
  pack: z.record(z.string(), z.unknown()),
  effectiveFrom: z.string().min(1),
  effectiveUntil: z.string().min(1).optional(),
});
const PackApproveSchema = z.strictObject({
  effectiveFrom: z.string().min(1),
  reason: z.string().min(1).max(2000).optional(),
});
const TelemetryQuerySchema = z.strictObject({
  robotId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const AuditQuerySchema = z.strictObject({
  subjectType: z.enum(["robot", "task", "plan", "exception", "agent-proposal", "constraint-pack"]).optional(),
  subjectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const RobotIdParamsSchema = z.strictObject({ robotId: z.string().min(1) });
const TaskIdParamsSchema = z.strictObject({ taskId: z.string().min(1) });
const PlanIdParamsSchema = z.strictObject({ planId: z.string().min(1) });
const ExceptionIdParamsSchema = z.strictObject({ exceptionId: z.string().min(1) });
const ProposalIdParamsSchema = z.strictObject({ proposalId: z.string().min(1) });
const PackIdParamsSchema = z.strictObject({ packId: z.string().min(1) });
const RunIdParamsSchema = z.strictObject({ runId: z.string().min(1) });

// ── Benchmark scenario parsing ────────────────────────────────────────────

const SitePointSchema = z.strictObject({ siteId: z.string().min(1), lat: z.number(), lon: z.number() });
const BenchmarkScenarioSchema = z.looseObject({
  scenarioId: z.string().min(1),
  seed: z.number().int(),
  start: z.string().min(1),
  horizonMinutes: z.number().int().positive(),
  fleet: z.array(z.record(z.string(), z.unknown())),
  tasks: z.array(z.record(z.string(), z.unknown())),
  sites: z.array(SitePointSchema),
  homeSiteId: z.string().min(1),
  localOffsetMinutes: z.number().int().optional(),
  weather: z
    .array(z.strictObject({ from: z.string().min(1), condition: z.enum(["clear", "light-rain", "wet-grass"]) }))
    .optional(),
  faultInjections: z
    .array(
      z.strictObject({
        robotId: z.string().min(1),
        ts: z.string().min(1),
        type: z.enum(["BATTERY", "STUCK", "SENSOR_DEGRADED", "COMMS_LOST", "WEATHER_HOLD", "MAINTENANCE_DUE"]),
        durationMinutes: z.number().positive(),
      }),
    )
    .optional(),
  connectivityWindows: z
    .array(z.strictObject({ robotId: z.string().min(1), from: z.string().min(1), until: z.string().min(1) }))
    .optional(),
  packs: z.array(z.record(z.string(), z.unknown())).optional(),
  objective: z.record(z.string(), z.unknown()).optional(),
  travelSpeedKmh: z.number().positive().optional(),
  travelDrainFactor: z.number().positive().optional(),
  tickMinutes: z.number().positive().optional(),
  replanIntervalMinutes: z.number().positive().optional(),
});

/** Validates a benchmark-scenario body into a runnable SimulationScenario. */
function parseScenario(value: unknown): SimulationScenario {
  const body = parseValue(value, BenchmarkScenarioSchema);
  const fleet: Robot[] = [];
  for (const candidate of body.fleet) {
    const parsed = RobotSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApiError(422, "SCENARIO_INVALID", `scenario fleet record failed RobotSchema: ${parsed.error.message}`);
    }
    fleet.push(parsed.data);
  }
  const tasks: SchedulableTask[] = [];
  for (const candidate of body.tasks) {
    // estMinutes is a SchedulableTask extension, not a FleetTask field —
    // strip it before schema validation or the strict object rejects it.
    const { estMinutes: est, ...taskRecord } = candidate as Record<string, unknown>;
    const parsed = FleetTaskSchema.safeParse(taskRecord);
    if (!parsed.success) {
      throw new ApiError(422, "SCENARIO_INVALID", `scenario task failed FleetTaskSchema: ${parsed.error.message}`);
    }
    if (typeof est !== "number" || est <= 0) {
      throw new ApiError(422, "SCENARIO_INVALID", "scenario tasks must carry a positive numeric estMinutes");
    }
    tasks.push({ ...parsed.data, estMinutes: est });
  }
  const packs: ExternalConstraintPack[] = [];
  for (const candidate of body.packs ?? []) {
    const parsed = ExternalConstraintPackSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApiError(422, "SCENARIO_INVALID", `scenario pack failed ExternalConstraintPackSchema: ${parsed.error.message}`);
    }
    packs.push(parsed.data);
  }
  return {
    scenarioId: body.scenarioId,
    seed: body.seed,
    start: body.start,
    horizonMinutes: body.horizonMinutes,
    fleet,
    tasks,
    sites: new Map(body.sites.map((site) => [site.siteId, { lat: site.lat, lon: site.lon }])),
    localOffsetMinutes: body.localOffsetMinutes ?? 0,
    ...(body.weather === undefined ? {} : { weather: body.weather }),
    faultInjections: body.faultInjections ?? [],
    connectivityWindows: body.connectivityWindows ?? [],
    packs,
    homeSiteId: body.homeSiteId,
    objective: body.objective ?? {},
    ...(body.travelSpeedKmh === undefined ? {} : { travelSpeedKmh: body.travelSpeedKmh }),
    ...(body.travelDrainFactor === undefined ? {} : { travelDrainFactor: body.travelDrainFactor }),
    ...(body.tickMinutes === undefined ? {} : { tickMinutes: body.tickMinutes }),
    ...(body.replanIntervalMinutes === undefined ? {} : { replanIntervalMinutes: body.replanIntervalMinutes }),
  };
}

/** Runs one scenario under both schedulers and computes the comparison deltas. */
function compareSchedulers(scenario: SimulationScenario): {
  baseline: RunMetrics;
  riskAware: RunMetrics;
  deltas: {
    onTimeCompletionDeltaPp: number;
    interventionReductionPct: number | null;
    energyCostDeltaUsd: number;
  };
} {
  const baseline = runSimulation(scenario, ruleBasedBaseline);
  const riskAware = runSimulation(scenario, planSchedule);
  const interventionReductionPct =
    baseline.interventionsPer100RobotHours > 0
      ? ((baseline.interventionsPer100RobotHours - riskAware.interventionsPer100RobotHours) /
          baseline.interventionsPer100RobotHours) *
        100
      : null;
  return {
    baseline,
    riskAware,
    deltas: {
      onTimeCompletionDeltaPp: (riskAware.onTimeCompletion - baseline.onTimeCompletion) * 100,
      interventionReductionPct,
      energyCostDeltaUsd: riskAware.energyCostUsd - baseline.energyCostUsd,
    },
  };
}

function planRowSummary(row: PlanRow) {
  return {
    planId: row.planId,
    plannerTag: row.plannerTag,
    status: row.status,
    createdAt: row.createdAt,
    committedAt: row.committedAt,
    assignments: row.plan.plan.assignments.length,
    charging: row.plan.charging.length,
    unassigned: row.plan.unassigned.length,
    projected: row.plan.plan.projected,
  };
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerRoutes(app: FastifyInstance, runtime: FleetOsRuntime): void {
  // Audit middleware: one append per state-changing request, unless the domain
  // layer already audited the action (serviceAudited) or the request failed.
  app.addHook("onSend", async (request, reply, payload) => {
    const config = ((request.routeOptions?.config ?? {}) as RouteConfig).audit;
    if (config === undefined || config.serviceAudited === true || reply.statusCode >= 400) {
      return payload;
    }
    let parsed: unknown;
    try {
      parsed = typeof payload === "string" ? (JSON.parse(payload) as unknown) : payload;
    } catch {
      parsed = undefined;
    }
    const fromResponse = config.subjectIdField === undefined ? undefined : readPath(parsed, config.subjectIdField);
    const fromRequest =
      config.requestSubjectField === undefined || request.body === null || typeof request.body !== "object"
        ? undefined
        : readPath(request.body, config.requestSubjectField);
    const params = (request.params ?? {}) as Record<string, unknown>;
    const subjectId = [
      fromResponse,
      fromRequest,
      params.robotId,
      params.taskId,
      params.planId,
      params.exceptionId,
      params.proposalId,
      params.packId,
      params.runId,
    ].find((candidate) => typeof candidate === "string" && candidate.length > 0);
    runtime.store.audit.append({
      at: runtime.clock.now(),
      actorType: "operator",
      actorId: operatorId(request),
      action: config.action,
      subjectType: config.subjectType,
      subjectId: typeof subjectId === "string" ? subjectId : "fleet",
      detail: { method: request.method, url: request.url, status: String(reply.statusCode) },
    });
    return payload;
  });

  const route = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    config: RouteConfig,
    handler: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>,
  ): void => {
    app.route({
      method,
      url,
      config,
      handler: async (request, reply) => {
        if (method !== "GET" && config.requiresOperator === true) {
          requireOperator(request);
        }
        return handler(request, reply);
      },
    });
  };

  // ── Fleet ─────────────────────────────────────────────────────────────

  route("GET", "/fleet/robots", {}, () => ({ robots: runtime.fleetView() }));

  route("GET", "/fleet/robots/:robotId", {}, (request) => {
    const { robotId } = parseParams(request, RobotIdParamsSchema);
    runtime.requireRobot(robotId); // 404 when unknown
    const view = runtime.fleetView().find((entry) => entry.robot.robotId === robotId);
    if (view === undefined) {
      throw new ApiError(404, "ROBOT_UNKNOWN", `no robot "${robotId}" in the fleet`);
    }
    return view;
  });

  route("GET", "/fleet/health", {}, () => ({
    ...runtime.healthSummary(),
    openExceptions: runtime.engine.openExceptions().length,
  }));

  route("GET", "/fleet/sites", {}, () => ({ sites: runtime.store.sites() }));

  route(
    "PATCH",
    "/fleet/robots/:robotId/residency",
    {
      requiresOperator: true,
      audit: { action: "robot-residency-updated", subjectType: "robot", subjectIdField: "robotId" },
    },
    (request) => {
      const { robotId } = parseParams(request, RobotIdParamsSchema);
      const body = parseBody(request, ResidencyPatchSchema);
      const robot = runtime.requireRobot(robotId);
      const residency = robot.compliance.dataResidency;
      const nextRegion = body.telemetryRegion ?? residency.telemetryRegion;
      runtime.assertRegionAllowed(nextRegion);
      const updated: Robot = {
        ...robot,
        compliance: {
          ...robot.compliance,
          dataResidency: {
            ...residency,
            telemetryRegion: nextRegion,
            ...(body.allowCrossBorderTelemetry === undefined
              ? {}
              : { allowCrossBorderTelemetry: body.allowCrossBorderTelemetry }),
          },
        },
      };
      runtime.store.putRobot(updated);
      return { robotId: robot.robotId, compliance: updated.compliance };
    },
  );

  // ── Tasks ─────────────────────────────────────────────────────────────

  route(
    "POST",
    "/tasks",
    {
      requiresOperator: true,
      audit: { action: "task-created", subjectType: "task", subjectIdField: "task.taskId" },
    },
    (request, reply) => {
      const body = parseBody(request, CreateTaskSchema);
      if (runtime.store.site(body.siteId) === null) {
        throw new ApiError(422, "SITE_UNKNOWN", `no site "${body.siteId}" — sites are bootstrap configuration`);
      }
      const taskId = body.taskId ?? `task-${String(runtime.store.tasks().length + 1).padStart(4, "0")}`;
      if (runtime.store.task(taskId) !== null) {
        throw new ApiError(409, "TASK_EXISTS", `task "${taskId}" already exists`);
      }
      const record: FleetTask = {
        schemaVersion: "1.0.0",
        taskId,
        siteId: body.siteId,
        requirements: body.requirements,
        window: body.window,
        priority: body.priority ?? 50,
        status: "pending",
      };
      const parsed = FleetTaskSchema.safeParse(record);
      if (!parsed.success) {
        throw new ApiError(422, "TASK_INVALID", `task record failed FleetTaskSchema: ${parsed.error.message}`, {
          issues: parsed.error.issues,
        });
      }
      const now = runtime.clock.now();
      runtime.store.putTask({
        taskId,
        siteId: body.siteId,
        status: "pending",
        priority: record.priority,
        notBefore: body.window.notBefore,
        notAfter: body.window.notAfter,
        estMinutes: body.estMinutes,
        record: parsed.data,
        createdAt: now,
        updatedAt: now,
      });
      reply.code(201);
      return { task: runtime.store.task(taskId) };
    },
  );

  route("GET", "/tasks", {}, () => {
    const held = new Set(runtime.engine.heldTasks());
    return { tasks: runtime.store.tasks().map((task) => ({ ...task, held: held.has(task.taskId) })) };
  });

  route("GET", "/tasks/:taskId", {}, (request) => {
    const { taskId } = parseParams(request, TaskIdParamsSchema);
    const task = runtime.store.task(taskId);
    if (task === null) {
      throw new ApiError(404, "TASK_UNKNOWN", `no task "${taskId}"`);
    }
    return { ...task, held: runtime.engine.heldTasks().includes(taskId) };
  });

  route(
    "PATCH",
    "/tasks/:taskId/status",
    {
      requiresOperator: true,
      audit: { action: "task-status-changed", subjectType: "task" },
    },
    (request) => {
      const { taskId } = parseParams(request, TaskIdParamsSchema);
      const body = parseBody(request, TaskStatusPatchSchema);
      const task = runtime.store.task(taskId);
      if (task === null) {
        throw new ApiError(404, "TASK_UNKNOWN", `no task "${taskId}"`);
      }
      if (runtime.engine.heldTasks().includes(taskId) && body.status !== "completed" && body.status !== "cancelled") {
        throw new ApiError(409, "TASK_HELD", `task "${taskId}" is HELD — release the exception before other transitions`);
      }
      const updated = {
        ...task,
        status: body.status,
        updatedAt: runtime.clock.now(),
        record: { ...task.record, status: body.status },
      };
      runtime.store.putTask(updated);
      return { task: updated };
    },
  );

  route(
    "POST",
    "/tasks/:taskId/reprioritize",
    {
      requiresOperator: true,
      audit: { action: "task-reprioritized", subjectType: "task", subjectIdField: "task.taskId" },
    },
    (request) => {
      const { taskId } = parseParams(request, TaskIdParamsSchema);
      const body = parseBody(request, ReprioritizeSchema);
      const task = runtime.store.task(taskId);
      if (task === null) {
        throw new ApiError(404, "TASK_UNKNOWN", `no task "${taskId}"`);
      }
      const record: FleetTask = { ...task.record, priority: body.priority };
      const updated = { ...task, priority: body.priority, updatedAt: runtime.clock.now(), record };
      runtime.store.putTask(updated);
      return { task: updated };
    },
  );

  // ── Schedule ──────────────────────────────────────────────────────────

  route(
    "POST",
    "/schedule/plan",
    {
      requiresOperator: true,
      audit: { action: "plan-computed", subjectType: "plan", subjectIdField: "plan.planId" },
    },
    (request, reply) => {
      const body = parseBody(request, PlanRequestSchema);
      const objective: SchedulingObjective = runtime.objective();
      const plan: SchedulerPlan = runtime.computePlan(body.scheduler ?? "risk-aware", objective);
      const row: PlanRow = {
        planId: plan.plan.planId,
        plannerTag: plan.plan.planId,
        status: "draft",
        createdAt: plan.plan.createdAt,
        committedAt: null,
        plan,
        objective,
      };
      runtime.store.putPlan(row);
      reply.code(201);
      return { plan: row };
    },
  );

  route(
    "POST",
    "/schedule/plans/:planId/commit",
    {
      requiresOperator: true,
      audit: { action: "plan-committed", subjectType: "plan", subjectIdField: "plan.planId" },
    },
    (request) => {
      const { planId } = parseParams(request, PlanIdParamsSchema);
      const row = runtime.store.plan(planId);
      if (row === null) {
        throw new ApiError(404, "PLAN_UNKNOWN", `no plan "${planId}"`);
      }
      if (row.status !== "draft") {
        throw new ApiError(409, "PLAN_NOT_DRAFT", `plan "${planId}" is ${row.status} — only draft plans commit`);
      }
      return { plan: runtime.commitPlan(row.plan, row.objective) };
    },
  );

  route("GET", "/schedule/plans", {}, () => ({ plans: runtime.store.plans().map(planRowSummary) }));

  route("GET", "/schedule/plans/current", {}, () => {
    const committed = runtime.store.committedPlan();
    if (committed === null) {
      throw new ApiError(404, "NO_COMMITTED_PLAN", "no plan has been committed yet");
    }
    return { plan: committed };
  });

  route("GET", "/schedule/plans/:planId", {}, (request) => {
    const { planId } = parseParams(request, PlanIdParamsSchema);
    const row = runtime.store.plan(planId);
    if (row === null) {
      throw new ApiError(404, "PLAN_UNKNOWN", `no plan "${planId}"`);
    }
    return { plan: row };
  });

  // ── Benchmarks ────────────────────────────────────────────────────────

  route(
    "POST",
    "/benchmarks/runs",
    {
      requiresOperator: true,
      audit: { action: "benchmark-run-recorded", subjectType: "plan", subjectIdField: "runId" },
    },
    (request, reply) => {
      const scenario = parseScenario(request.body);
      const comparison = compareSchedulers(scenario);
      const createdAt = runtime.clock.now();
      const runId = `bench-${String(runtime.store.benchmarkRuns().length + 1).padStart(3, "0")}`;
      const report = { runId, createdAt, scenarioId: scenario.scenarioId, seed: scenario.seed, ...comparison };
      runtime.store.putBenchmarkRun({ runId, scenarioId: scenario.scenarioId, createdAt, report });
      reply.code(201);
      return report;
    },
  );

  route("GET", "/benchmarks/runs", {}, () => ({
    runs: runtime.store.benchmarkRuns().map((run) => run.report),
  }));

  route("GET", "/benchmarks/runs/:runId", {}, (request) => {
    const { runId } = parseParams(request, RunIdParamsSchema);
    const row = runtime.store.benchmarkRun(runId);
    if (row === null) {
      throw new ApiError(404, "RUN_UNKNOWN", `no benchmark run "${runId}"`);
    }
    return row.report;
  });

  // ── Exceptions & interventions ────────────────────────────────────────

  route("GET", "/exceptions", {}, () => ({ exceptions: runtime.engine.exceptions() }));

  route("GET", "/exceptions/:exceptionId", {}, (request) => {
    const { exceptionId } = parseParams(request, ExceptionIdParamsSchema);
    return { exception: runtime.engine.exception(exceptionId) };
  });

  route(
    "POST",
    "/exceptions/:exceptionId/acknowledge",
    {
      requiresOperator: true,
      audit: { action: "exception-acknowledged", subjectType: "exception", serviceAudited: true },
    },
    (request) => {
      const { exceptionId } = parseParams(request, ExceptionIdParamsSchema);
      return { exception: runtime.engine.acknowledgeException(exceptionId, requireOperator(request)) };
    },
  );

  route(
    "POST",
    "/exceptions/:exceptionId/release",
    {
      requiresOperator: true,
      audit: { action: "exception-released", subjectType: "exception", serviceAudited: true },
    },
    (request) => {
      const { exceptionId } = parseParams(request, ExceptionIdParamsSchema);
      const body = parseBody(request, ReasonSchema);
      return { exception: runtime.engine.releaseException(exceptionId, requireOperator(request), body.reason) };
    },
  );

  route(
    "POST",
    "/exceptions/:exceptionId/recovery",
    {
      requiresOperator: true,
      audit: { action: "exception-recovery-decided", subjectType: "exception", serviceAudited: true },
    },
    async (request) => {
      const { exceptionId } = parseParams(request, ExceptionIdParamsSchema);
      const body = parseBody(request, RecoveryDecisionSchema);
      const outcome: RecoveryDecisionOutcome = await runtime.decideRecovery(exceptionId, {
        operatorId: requireOperator(request),
        decision: body.decision,
        reason: body.reason,
      });
      return {
        decision: outcome.decision,
        resolution: outcome.resolution,
        intervention: outcome.intervention,
        ticket: outcome.ticket,
      };
    },
  );

  route(
    "POST",
    "/interventions",
    {
      requiresOperator: true,
      audit: { action: "intervention-recorded", subjectType: "robot", serviceAudited: true },
    },
    async (request, reply) => {
      const body = parseBody(request, InterventionSchema);
      runtime.requireRobot(body.robotId);
      let ticket = null;
      if (body.kind === "pause" || body.kind === "resume") {
        const permission: CommandPermission = body.kind === "pause" ? "PAUSE" : "RESUME";
        ticket = await runtime.adapterForRobot(body.robotId).sendCommand({ robotId: body.robotId, command: permission });
      }
      const intervention = runtime.engine.recordIntervention({
        robotId: body.robotId,
        kind: body.kind,
        operatorId: requireOperator(request),
        reason: body.reason,
        ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
        ...(runtime.store.committedPlan()?.planId
          ? { planId: runtime.store.committedPlan()!.planId }
          : {}),
      });
      reply.code(201);
      return { intervention, ...(ticket === null ? {} : { ticket }) };
    },
  );

  route("GET", "/interventions", {}, () => ({ interventions: runtime.engine.interventions() }));

  // ── Agent proposals ───────────────────────────────────────────────────

  route("GET", "/agent-proposals", {}, () => ({ proposals: runtime.store.proposals() }));

  route(
    "POST",
    "/agent-proposals/generate",
    {
      requiresOperator: true,
      audit: { action: "agent-proposal-requested", subjectType: "agent-proposal", requestSubjectField: "robotId" },
    },
    (request, reply) => {
      const body = parseBody(request, GenerateProposalSchema);
      const result = runtime.generateProposal(body.robotId);
      if (result === null) {
        reply.code(204);
        return;
      }
      reply.code(201);
      return result;
    },
  );

  route(
    "POST",
    "/agent-proposals/:proposalId/approve",
    {
      requiresOperator: true,
      audit: { action: "agent-proposal-approved", subjectType: "agent-proposal", subjectIdField: "proposal.proposalId" },
    },
    (request) => {
      const { proposalId } = parseParams(request, ProposalIdParamsSchema);
      const body = parseBody(request, ReasonSchema);
      return runtime.approveProposal(proposalId, requireOperator(request), body.reason);
    },
  );

  route(
    "POST",
    "/agent-proposals/:proposalId/reject",
    {
      requiresOperator: true,
      audit: { action: "agent-proposal-rejected", subjectType: "agent-proposal", serviceAudited: true },
    },
    (request) => {
      const { proposalId } = parseParams(request, ProposalIdParamsSchema);
      const body = parseBody(request, ReasonSchema);
      return { proposal: runtime.rejectProposal(proposalId, requireOperator(request), body.reason) };
    },
  );

  // ── Constraint packs ──────────────────────────────────────────────────

  route(
    "POST",
    "/constraint-packs",
    {
      requiresOperator: true,
      audit: { action: "constraint-pack-uploaded", subjectType: "constraint-pack", subjectIdField: "packId" },
    },
    (request, reply) => {
      const body = parseBody(request, PackUploadSchema);
      const parsedPack = ExternalConstraintPackSchema.safeParse(body.pack);
      if (!parsedPack.success) {
        throw new ApiError(
          400,
          "PACK_PARSE_FAILED",
          `constraint pack failed schema validation: ${parsedPack.error.message}`,
          { issues: parsedPack.error.issues },
        );
      }
      const pack = parsedPack.data;
      // Pre-check the versioned registry (overlap + window invariants) before persisting.
      const proposed = {
        pack,
        effectiveFrom: body.effectiveFrom,
        ...(body.effectiveUntil === undefined ? {} : { effectiveUntil: body.effectiveUntil }),
      };
      const existing = runtime.store
        .packVersions()
        .filter((version) => version.approved)
        .map((version) =>
          version.effectiveUntil === null
            ? { pack: version.pack, effectiveFrom: version.effectiveFrom }
            : { pack: version.pack, effectiveFrom: version.effectiveFrom, effectiveUntil: version.effectiveUntil },
        );
      createPackLibrary([...existing, proposed]); // ConstraintError PACK_VERSIONS_OVERLAP on conflict

      runtime.store.putPackVersion({
        packId: pack.packId,
        effectiveFrom: body.effectiveFrom,
        effectiveUntil: body.effectiveUntil ?? null,
        approved: pack.provenance.humanApproved,
        pack,
        uploadedAt: runtime.clock.now(),
      });
      runtime.rebuildPackLibrary();
      reply.code(201);
      return {
        packId: pack.packId,
        effectiveFrom: body.effectiveFrom,
        effectiveUntil: body.effectiveUntil ?? null,
        approved: pack.provenance.humanApproved,
      };
    },
  );

  route("GET", "/constraint-packs", {}, () => ({ versions: runtime.store.packVersions() }));

  route(
    "POST",
    "/constraint-packs/:packId/approve",
    {
      requiresOperator: true,
      audit: { action: "constraint-pack-approved", subjectType: "constraint-pack", subjectIdField: "packId" },
    },
    (request) => {
      const { packId } = parseParams(request, PackIdParamsSchema);
      const body = parseBody(request, PackApproveSchema);
      const row = runtime.store
        .packVersions()
        .find((version) => version.packId === packId && version.effectiveFrom === body.effectiveFrom);
      if (row === undefined) {
        throw new ApiError(
          404,
          "PACK_VERSION_UNKNOWN",
          `no version of pack "${packId}" effective from "${body.effectiveFrom}"`,
        );
      }
      runtime.store.putPackVersion({ ...row, approved: true });
      runtime.rebuildPackLibrary();
      return { packId: row.packId, effectiveFrom: row.effectiveFrom, effectiveUntil: row.effectiveUntil, approved: true };
    },
  );

  // ── Telemetry & minimization ──────────────────────────────────────────

  route(
    "POST",
    "/telemetry/ingest",
    { audit: { action: "telemetry-ingested", subjectType: "robot", serviceAudited: true } },
    async (request, reply) => {
      const outcome = await runtime.ingestTelemetryPayload(request.body);
      reply.code(201);
      return outcome;
    },
  );

  route("GET", "/telemetry", {}, (request) => {
    const query = parseQuery(request, TelemetryQuerySchema);
    const robot = runtime.requireRobot(query.robotId);
    const region = robot.compliance.dataResidency.telemetryRegion;
    return {
      region,
      samples: runtime.store.telemetryStore(region).list(robot.robotId, query.limit ?? 100),
    };
  });

  route("GET", "/telemetry/minimization", {}, () => ({ robots: runtime.minimizationSummary() }));

  // ── Audit trail & config ──────────────────────────────────────────────

  route("GET", "/audit", {}, (request) => {
    const query = parseQuery(request, AuditQuerySchema);
    let entries = runtime.store.audit.entries();
    if (query.subjectType !== undefined) {
      entries = entries.filter((entry) => entry.subjectType === query.subjectType);
    }
    if (query.subjectId !== undefined) {
      entries = entries.filter((entry) => entry.subjectId === query.subjectId);
    }
    return { entries: entries.slice(-1 * (query.limit ?? 200)).reverse() };
  });

  route("GET", "/config/residency", {}, () => ({
    allowedRegions: runtime.allowedRegionList(),
    note: "residency regions are deployment configuration; per-robot routing lives in the robot's compliance block",
  }));
}
