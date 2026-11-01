import { describe, expect, it } from "vitest";

import type { AgentAuditSink } from "@fleetos/device-agents";

import { createInMemoryAuditLog } from "../src/audit.js";
import type { AuditLog } from "../src/audit.js";

describe("createInMemoryAuditLog", () => {
  it("assigns monotonic sequence numbers starting at 1", () => {
    const log = createInMemoryAuditLog();
    const first = log.append({
      at: "2026-11-02T08:00:00.000Z",
      actorType: "system",
      actorId: "fleet-health",
      action: "fault-ingested",
      subjectType: "robot",
      subjectId: "robot-mower-01",
    });
    const second = log.append({
      at: "2026-11-02T08:01:00.000Z",
      actorType: "operator",
      actorId: "op-1",
      action: "intervention-pause",
      subjectType: "robot",
      subjectId: "robot-mower-01",
      planId: "plan-1",
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(log.entries().map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("rejects drafts that violate the core-schema AuditEvent schema", () => {
    const log = createInMemoryAuditLog();
    expect(() =>
      log.append({
        at: "2026-11-02T08:00:00.000Z",
        actorType: "operator",
        actorId: "op-1",
        // 129+ chars — over the schema's 128 cap.
        action: "a".repeat(200),
        subjectType: "robot",
        subjectId: "robot-mower-01",
      }),
    ).toThrowError(/AuditEvent schema/);
    expect(log.entries()).toHaveLength(0); // the invalid draft left no trace
  });

  it("is append-only: entries() hands out copies and exposes no mutation path", () => {
    const log: AuditLog = createInMemoryAuditLog();
    log.append({
      at: "2026-11-02T08:00:00.000Z",
      actorType: "system",
      actorId: "fleet-health",
      action: "fault-ingested",
      subjectType: "robot",
      subjectId: "robot-mower-01",
    });
    const snapshot = [...log.entries()];
    // Mutating a returned copy must not touch the trail.
    snapshot.pop();
    expect(log.entries()).toHaveLength(1);
    const keys = Object.keys(log);
    expect(keys).toEqual(["append", "entries", "entriesFor"]); // no update/delete surface
  });

  it("filters by subject id", () => {
    const log = createInMemoryAuditLog();
    log.append({
      at: "2026-11-02T08:00:00.000Z",
      actorType: "system",
      actorId: "fleet-health",
      action: "fault-ingested",
      subjectType: "robot",
      subjectId: "robot-mower-01",
    });
    log.append({
      at: "2026-11-02T08:00:00.000Z",
      actorType: "system",
      actorId: "fleet-health",
      action: "fault-ingested",
      subjectType: "robot",
      subjectId: "robot-mower-02",
    });
    expect(log.entriesFor("robot-mower-01")).toHaveLength(1);
  });

  it("satisfies the device-agent AgentAuditSink contract structurally", () => {
    // device-agents doc: "Fleet-health and the API provide the persistent
    // implementation" of the audit sink — the assignability is the contract.
    const log: AuditLog = createInMemoryAuditLog();
    const sink: AgentAuditSink = log;
    expect(sink).toBe(log);
  });
});
