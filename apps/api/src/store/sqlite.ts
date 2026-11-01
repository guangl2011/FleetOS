import { mkdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import type {
  AuditEvent,
  ExternalConstraintPack,
  FleetTask,
  Robot,
} from "@fleetos/core-schema";
import type { AuditLog } from "@fleetos/fleet-health";
import type { AssignedEnvelope, SchedulerPlan, SchedulingObjective } from "@fleetos/scheduler";
import type { ReplanProposal, ReplanReview } from "@fleetos/device-agents";
import type { TelemetrySample } from "@fleetos/core-schema";

/**
 * SQLite persistence for the API (spec stack decision: Fastify + SQLite).
 * One main store holds everything except telemetry; telemetry lives in one
 * file per data-residency region (`telemetry/<region>.sqlite`) — data
 * residency is enforced by construction, because a region's rows physically
 * cannot share a database with another region's.
 */

export interface SiteRow {
  readonly siteId: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export interface TaskRow {
  readonly taskId: string;
  readonly siteId: string;
  readonly status: string;
  readonly priority: number;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly estMinutes: number;
  readonly record: FleetTask;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlanStatus = "draft" | "committed" | "superseded";

export interface PlanRow {
  readonly planId: string;
  readonly plannerTag: string;
  readonly status: PlanStatus;
  readonly createdAt: string;
  readonly committedAt: string | null;
  readonly plan: SchedulerPlan;
  readonly objective: SchedulingObjective;
}

export interface EnvelopeRow {
  readonly envelopeId: string;
  readonly planId: string;
  readonly robotId: string;
  readonly envelope: AssignedEnvelope;
}

export interface PackVersionRow {
  readonly packId: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly approved: boolean;
  readonly pack: ExternalConstraintPack;
  readonly uploadedAt: string;
}

export interface BenchmarkRunRow {
  readonly runId: string;
  readonly scenarioId: string;
  readonly createdAt: string;
  readonly report: unknown;
}

export interface ProposalRow {
  readonly proposalId: string;
  readonly robotId: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly proposal: ReplanProposal;
  readonly review: ReplanReview;
}

export interface TelemetrySampleRow {
  readonly robotId: string;
  readonly ts: string;
  readonly sample: TelemetrySample;
  readonly droppedFields: readonly string[];
}

/** Implemented structurally by FleetStore — the packages only ever need this shape. */
type AuditDraft = Omit<AuditEvent, "seq">;

const COLON_SAFE = /[^A-Za-z0-9._:-]/g;

export class FleetStore {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly regionDbs = new Map<string, Database.Database>();
  private closed = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "fleetos.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        plan_id TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS robots (
        robot_id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sites (
        site_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        not_before TEXT NOT NULL,
        not_after TEXT NOT NULL,
        est_minutes REAL NOT NULL,
        record TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        planner_tag TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        committed_at TEXT,
        plan TEXT NOT NULL,
        objective TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_envelopes (
        envelope_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        envelope TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pack_versions (
        pack_id TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_until TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        pack TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        PRIMARY KEY (pack_id, effective_from)
      );
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        run_id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        report TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_proposals (
        proposal_id TEXT PRIMARY KEY,
        robot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decision_reason TEXT,
        proposal TEXT NOT NULL,
        review TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ── Audit trail (AuditLog + AgentAuditSink) ─────────────────────────────

  /** Append-only audit trail (spec fleet-health + data-compliance chapters). */
  readonly audit: AuditLog = {
    append: (draft: AuditDraft): AuditEvent => {
      const row = this.db
        .prepare(
          `INSERT INTO audit_events (at, actor_type, actor_id, action, subject_type, subject_id, plan_id, detail)
           VALUES (@at, @actorType, @actorId, @action, @subjectType, @subjectId, @planId, @detail)`,
        )
        .run({
          at: draft.at,
          actorType: draft.actorType,
          actorId: draft.actorId,
          action: draft.action,
          subjectType: draft.subjectType,
          subjectId: draft.subjectId,
          planId: draft.planId ?? null,
          detail: draft.detail === undefined ? null : JSON.stringify(draft.detail),
        });
      return {
        seq: Number(row.lastInsertRowid),
        ...draft,
        ...(draft.planId === undefined ? {} : { planId: draft.planId }),
        ...(draft.detail === undefined ? {} : { detail: draft.detail }),
      };
    },
    entries: (): readonly AuditEvent[] => {
      const rows = this.db.prepare(`SELECT * FROM audit_events ORDER BY seq`).all() as Array<
        Record<string, unknown>
      >;
      return rows.map(rowToAuditEvent);
    },
    entriesFor: (subjectId: string): readonly AuditEvent[] => {
      const rows = this.db
        .prepare(`SELECT * FROM audit_events WHERE subject_id = ? ORDER BY seq`)
        .all(subjectId) as Array<Record<string, unknown>>;
      return rows.map(rowToAuditEvent);
    },
  };

  // ── Robots ──────────────────────────────────────────────────────────────

  putRobot(robot: Robot): void {
    this.db
      .prepare(`INSERT INTO robots (robot_id, record) VALUES (?, ?)
                ON CONFLICT(robot_id) DO UPDATE SET record = excluded.record`)
      .run(robot.robotId, JSON.stringify(robot));
  }

  robot(robotId: string): Robot | null {
    const row = this.db.prepare(`SELECT record FROM robots WHERE robot_id = ?`).get(robotId) as
      | { record: string }
      | undefined;
    return row === undefined ? null : (JSON.parse(row.record) as Robot);
  }

  robots(): readonly Robot[] {
    const rows = this.db.prepare(`SELECT record FROM robots ORDER BY robot_id`).all() as Array<{
      record: string;
    }>;
    return rows.map((r) => JSON.parse(r.record) as Robot);
  }

  // ── Sites ───────────────────────────────────────────────────────────────

  site(siteId: string): SiteRow | null {
    const row = this.db
      .prepare(`SELECT site_id AS siteId, name, lat, lon FROM sites WHERE site_id = ?`)
      .get(siteId) as SiteRow | undefined;
    return row === undefined ? null : row;
  }

  putSite(site: SiteRow): void {
    this.db
      .prepare(`INSERT INTO sites (site_id, name, lat, lon) VALUES (?, ?, ?, ?)
                ON CONFLICT(site_id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon`)
      .run(site.siteId, site.name, site.lat, site.lon);
  }

  sites(): readonly SiteRow[] {
    return this.db
      .prepare(`SELECT site_id AS siteId, name, lat, lon FROM sites ORDER BY site_id`)
      .all() as readonly SiteRow[];
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  putTask(task: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, site_id, status, priority, not_before, not_after, est_minutes, record, created_at, updated_at)
         VALUES (@taskId, @siteId, @status, @priority, @notBefore, @notAfter, @estMinutes, @record, @createdAt, @updatedAt)
         ON CONFLICT(task_id) DO UPDATE SET
           site_id = excluded.site_id, status = excluded.status, priority = excluded.priority,
           not_before = excluded.not_before, not_after = excluded.not_after, est_minutes = excluded.est_minutes,
           record = excluded.record, updated_at = excluded.updated_at`,
      )
      .run({ ...task, record: JSON.stringify(task.record) });
  }

  task(taskId: string): TaskRow | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowToTask(row);
  }

  tasks(): readonly TaskRow[] {
    const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY task_id`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToTask);
  }

  // ── Plans ───────────────────────────────────────────────────────────────

  putPlan(plan: PlanRow): void {
    this.db
      .prepare(
        `INSERT INTO plans (plan_id, planner_tag, status, created_at, committed_at, plan, objective)
         VALUES (@planId, @plannerTag, @status, @createdAt, @committedAt, @plan, @objective)
         ON CONFLICT(plan_id) DO UPDATE SET
           planner_tag = excluded.planner_tag, status = excluded.status, created_at = excluded.created_at,
           committed_at = excluded.committed_at, plan = excluded.plan, objective = excluded.objective`,
      )
      .run({
        ...plan,
        committedAt: plan.committedAt,
        plan: JSON.stringify(plan.plan),
        objective: JSON.stringify(plan.objective),
      });
  }

  plan(planId: string): PlanRow | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE plan_id = ?`).get(planId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowToPlan(row);
  }

  plans(): readonly PlanRow[] {
    const rows = this.db.prepare(`SELECT * FROM plans ORDER BY created_at`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToPlan);
  }

  committedPlan(): PlanRow | null {
    const row = this.db
      .prepare(`SELECT * FROM plans WHERE status = 'committed' ORDER BY committed_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToPlan(row);
  }

  setPlanStatus(planId: string, status: PlanStatus, committedAt: string | null): void {
    this.db
      .prepare(`UPDATE plans SET status = ?, committed_at = ? WHERE plan_id = ?`)
      .run(status, committedAt, planId);
  }

  // ── Envelopes ───────────────────────────────────────────────────────────

  putEnvelope(row: EnvelopeRow): void {
    this.db
      .prepare(
        `INSERT INTO plan_envelopes (envelope_id, plan_id, robot_id, envelope) VALUES (?, ?, ?, ?)
         ON CONFLICT(envelope_id) DO UPDATE SET envelope = excluded.envelope`,
      )
      .run(row.envelopeId, row.planId, row.robotId, JSON.stringify(row.envelope));
  }

  envelopes(planId: string): readonly EnvelopeRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM plan_envelopes WHERE plan_id = ? ORDER BY robot_id`)
      .all(planId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      envelopeId: String(row.envelope_id),
      planId: String(row.plan_id),
      robotId: String(row.robot_id),
      envelope: JSON.parse(String(row.envelope)) as AssignedEnvelope,
    }));
  }

  // ── Constraint packs ────────────────────────────────────────────────────

  putPackVersion(row: PackVersionRow): void {
    this.db
      .prepare(
        `INSERT INTO pack_versions (pack_id, effective_from, effective_until, approved, pack, uploaded_at)
         VALUES (@packId, @effectiveFrom, @effectiveUntil, @approved, @pack, @uploadedAt)
         ON CONFLICT(pack_id, effective_from) DO UPDATE SET
           effective_until = excluded.effective_until, approved = excluded.approved,
           pack = excluded.pack, uploaded_at = excluded.uploaded_at`,
      )
      .run({
        ...row,
        effectiveUntil: row.effectiveUntil,
        approved: row.approved ? 1 : 0,
        pack: JSON.stringify(row.pack),
      });
  }

  packVersions(): readonly PackVersionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM pack_versions ORDER BY pack_id, effective_from`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      packId: String(row.pack_id),
      effectiveFrom: String(row.effective_from),
      effectiveUntil: row.effective_until === null ? null : String(row.effective_until),
      approved: Number(row.approved) === 1,
      pack: JSON.parse(String(row.pack)) as ExternalConstraintPack,
      uploadedAt: String(row.uploaded_at),
    }));
  }

  // ── Benchmarks ──────────────────────────────────────────────────────────

  putBenchmarkRun(run: BenchmarkRunRow): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_runs (run_id, scenario_id, created_at, report) VALUES (?, ?, ?, ?)`,
      )
      .run(run.runId, run.scenarioId, run.createdAt, JSON.stringify(run.report));
  }

  benchmarkRuns(): readonly BenchmarkRunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM benchmark_runs ORDER BY created_at`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToBenchmarkRun);
  }

  benchmarkRun(runId: string): BenchmarkRunRow | null {
    const row = this.db.prepare(`SELECT * FROM benchmark_runs WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowToBenchmarkRun(row);
  }

  // ── Agent proposals ─────────────────────────────────────────────────────

  putProposal(row: ProposalRow): void {
    this.db
      .prepare(
        `INSERT INTO agent_proposals (proposal_id, robot_id, status, created_at, decided_at, decision_reason, proposal, review)
         VALUES (@proposalId, @robotId, @status, @createdAt, @decidedAt, @decisionReason, @proposal, @review)
         ON CONFLICT(proposal_id) DO UPDATE SET
           status = excluded.status, decided_at = excluded.decided_at,
           decision_reason = excluded.decision_reason, review = excluded.review`,
      )
      .run({
        ...row,
        decidedAt: row.decidedAt,
        decisionReason: row.decisionReason,
        proposal: JSON.stringify(row.proposal),
        review: JSON.stringify(row.review),
      });
  }

  proposals(): readonly ProposalRow[] {
    const rows = this.db.prepare(`SELECT * FROM agent_proposals ORDER BY created_at`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToProposal);
  }

  proposal(proposalId: string): ProposalRow | null {
    const row = this.db.prepare(`SELECT * FROM agent_proposals WHERE proposal_id = ?`).get(proposalId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowToProposal(row);
  }

  // ── Config (key/value, e.g. residency region set) ───────────────────────

  getConfig(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? null : row.value;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO config (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // ── Telemetry (per-region stores) ───────────────────────────────────────

  /**
   * Opens (or returns) the store for one residency region. The region slug
   * is validated against the same core-schema pattern the compliance block
   * uses before it may touch a filesystem path.
   */
  telemetryStore(region: string): TelemetryRegionStore {
    if (this.closed) {
      throw new Error("store is closed");
    }
    const slug = region.replace(COLON_SAFE, "");
    if (slug !== region || slug.length === 0) {
      throw new Error(`invalid residency region slug: ${region}`);
    }
    const existing = this.regionDbs.get(slug);
    if (existing !== undefined) {
      return new TelemetryRegionStore(slug, existing);
    }
    const dir = join(this.dataDir, "telemetry");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, `${slug}.sqlite`));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_samples (
        robot_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        sample TEXT NOT NULL,
        dropped TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS telemetry_robot_ts ON telemetry_samples (robot_id, ts);
    `);
    this.regionDbs.set(slug, db);
    return new TelemetryRegionStore(slug, db);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const db of this.regionDbs.values()) {
      db.close();
    }
    this.regionDbs.clear();
    this.db.close();
  }
}

export class TelemetryRegionStore {
  constructor(
    readonly region: string,
    private readonly db: Database.Database,
  ) {}

  insert(sample: TelemetrySample, droppedFields: readonly string[]): void {
    this.db
      .prepare(`INSERT INTO telemetry_samples (robot_id, ts, sample, dropped) VALUES (?, ?, ?, ?)`)
      .run(sample.robotId, sample.ts, JSON.stringify(sample), JSON.stringify(droppedFields));
  }

  list(robotId: string | null, limit: number): readonly TelemetrySampleRow[] {
    const rows =
      robotId === null
        ? (this.db
            .prepare(`SELECT * FROM telemetry_samples ORDER BY ts DESC LIMIT ?`)
            .all(limit) as Array<Record<string, unknown>>)
        : (this.db
            .prepare(`SELECT * FROM telemetry_samples WHERE robot_id = ? ORDER BY ts DESC LIMIT ?`)
            .all(robotId, limit) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      robotId: String(row.robot_id),
      ts: String(row.ts),
      sample: JSON.parse(String(row.sample)) as TelemetrySample,
      droppedFields: JSON.parse(String(row.dropped)) as readonly string[],
    }));
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry_samples`).get() as { n: number };
    return Number(row.n);
  }
}

// ── Row mappers ───────────────────────────────────────────────────────────

function rowToAuditEvent(row: Record<string, unknown>): AuditEvent {
  const detail = row.detail === null || row.detail === undefined ? undefined : JSON.parse(String(row.detail));
  const planId = row.plan_id === null || row.plan_id === undefined ? undefined : String(row.plan_id);
  return {
    seq: Number(row.seq),
    at: String(row.at),
    actorType: String(row.actor_type) as AuditEvent["actorType"],
    actorId: String(row.actor_id),
    action: String(row.action),
    subjectType: String(row.subject_type) as AuditEvent["subjectType"],
    subjectId: String(row.subject_id),
    ...(planId === undefined ? {} : { planId }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    taskId: String(row.task_id),
    siteId: String(row.site_id),
    status: String(row.status),
    priority: Number(row.priority),
    notBefore: String(row.not_before),
    notAfter: String(row.not_after),
    estMinutes: Number(row.est_minutes),
    record: JSON.parse(String(row.record)) as FleetTask,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToPlan(row: Record<string, unknown>): PlanRow {
  return {
    planId: String(row.plan_id),
    plannerTag: String(row.planner_tag),
    status: String(row.status) as PlanStatus,
    createdAt: String(row.created_at),
    committedAt: row.committed_at === null ? null : String(row.committed_at),
    plan: JSON.parse(String(row.plan)) as SchedulerPlan,
    objective: JSON.parse(String(row.objective)) as SchedulingObjective,
  };
}

function rowToBenchmarkRun(row: Record<string, unknown>): BenchmarkRunRow {
  return {
    runId: String(row.run_id),
    scenarioId: String(row.scenario_id),
    createdAt: String(row.created_at),
    report: JSON.parse(String(row.report)),
  };
}

function rowToProposal(row: Record<string, unknown>): ProposalRow {
  return {
    proposalId: String(row.proposal_id),
    robotId: String(row.robot_id),
    status: String(row.status) as ProposalRow["status"],
    createdAt: String(row.created_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    decisionReason: row.decision_reason === null ? null : String(row.decision_reason),
    proposal: JSON.parse(String(row.proposal)) as ReplanProposal,
    review: JSON.parse(String(row.review)) as ReplanReview,
  };
}
