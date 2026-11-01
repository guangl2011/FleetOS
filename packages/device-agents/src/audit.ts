import { AuditEventSchema } from "@fleetos/core-schema";
import type { AuditEvent } from "@fleetos/core-schema";

import { AgentError } from "./errors.js";

/**
 * An audit entry before the sink assigns its sequence number. The sink owns
 * `seq` — producers never guess their position in an append-only history.
 */
export type AuditDraft = Omit<AuditEvent, "seq">;

/**
 * Where the agent appends its audit events. Fleet-health and the API provide
 * the persistent implementation; the in-memory trail below serves tests and
 * the benchmark. Append is the entire write surface — history is never
 * edited (spec fleet-health chapter: audit trail as compliance evidence).
 */
export interface AgentAuditSink {
  append(draft: AuditDraft): AuditEvent;
}

export interface AgentAuditTrail extends AgentAuditSink {
  entries(): readonly AuditEvent[];
  entriesFor(subjectId: string): readonly AuditEvent[];
}

/**
 * In-memory append-only trail with sink-assigned monotonic `seq` and schema
 * validation — a draft that does not satisfy the core-schema AuditEvent
 * schema fails loudly instead of silently corrupting the evidence base.
 */
export function createInMemoryAuditTrail(): AgentAuditTrail {
  const entries: AuditEvent[] = [];
  return {
    append(draft: AuditDraft): AuditEvent {
      const candidate = { ...draft, seq: entries.length + 1 };
      const parsed = AuditEventSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new AgentError(
          "AUDIT_EVENT_INVALID",
          `audit draft for subject "${draft.subjectId}" failed the AuditEvent schema: ${parsed.error.message}`,
          // exactOptionalPropertyTypes: never pass an explicit undefined.
          ...(draft.subjectType === "robot" ? [{ robotId: draft.subjectId }] : []),
        );
      }
      entries.push(parsed.data);
      return parsed.data;
    },
    entries: () => [...entries],
    entriesFor: (subjectId: string) => entries.filter((event) => event.subjectId === subjectId),
  };
}
