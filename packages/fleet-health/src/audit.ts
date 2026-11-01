import { AuditEventSchema } from "@fleetos/core-schema";
import type { AuditEvent } from "@fleetos/core-schema";

import { FleetHealthError } from "./errors.js";

/**
 * The append-only audit-trail store (spec fleet-health chapter, audit-trail
 * completeness §6.3): every state change that affects a task or robot lands
 * here — operator command, system action, timestamp, plan version in effect.
 * The trail doubles as the compliance evidence base (spec data-compliance
 * chapter) and audits every device-agent proposal that reaches fleet-health.
 *
 * Structurally compatible with the device-agent `AgentAuditSink`/`AgentAuditTrail`
 * contracts (device-agents package doc: "Fleet-health and the API provide the
 * persistent implementation") — the type-level test pins that assignability.
 */

/** An audit entry before the log assigns its sequence number. The log owns `seq`. */
export type AuditDraft = Omit<AuditEvent, "seq">;

export interface AuditLog {
  append(draft: AuditDraft): AuditEvent;
  entries(): readonly AuditEvent[];
  entriesFor(subjectId: string): readonly AuditEvent[];
}

/**
 * In-memory append-only log with sink-assigned monotonic `seq` and schema
 * validation — a draft that does not satisfy the core-schema AuditEvent
 * schema fails loudly instead of silently corrupting the evidence base.
 * `entries()` returns copies over an internal array; no update or delete
 * path exists (testing plan §2.7).
 */
export function createInMemoryAuditLog(): AuditLog {
  const entries: AuditEvent[] = [];
  return {
    append(draft: AuditDraft): AuditEvent {
      const candidate = { ...draft, seq: entries.length + 1 };
      const parsed = AuditEventSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new FleetHealthError(
          "AUDIT_EVENT_INVALID",
          `audit draft for subject "${draft.subjectId}" failed the AuditEvent schema: ${parsed.error.message}`,
        );
      }
      entries.push(parsed.data);
      return parsed.data;
    },
    entries: () => [...entries],
    entriesFor: (subjectId: string) => entries.filter((event) => event.subjectId === subjectId),
  };
}
