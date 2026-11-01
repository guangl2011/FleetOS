import { z } from "zod";

import { AuditEventSchema } from "./audit.js";
import { RobotCapabilitySchema } from "./capability.js";
import { ComplianceBlockSchema, DataFlowProfileSchema } from "./compliance.js";
import { ExternalConstraintPackSchema, SiteSelectorSchema } from "./constraints.js";
import { DispatchPlanSchema, ScheduleEntrySchema } from "./plan.js";
import { FaultEventSchema } from "./fault.js";
import { InterventionSchema } from "./intervention.js";
import { FleetTaskSchema } from "./task.js";
import { RobotSchema } from "./robot.js";
import { TelemetrySampleSchema } from "./telemetry.js";

/**
 * The published JSON Schema surface: one draft 2020-12 document per domain
 * record, generated from the Zod schemas (the single source of truth) by
 * `scripts/generate-schemas.ts` and checked in under `schemas/` for non-TS
 * consumers. The parity test compiles every checked-in file with Ajv and
 * asserts it accepts/rejects the same samples as its Zod counterpart; a
 * freshness check fails when a file no longer matches regeneration output.
 */

/** One generated JSON Schema document — plain JSON by construction. */
export type JsonSchemaDocument = Record<string, unknown>;

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export interface SchemaRegistryEntry {
  /** File stem: schemas/<name>.schema.json. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: z.ZodType;
}

export const SCHEMA_REGISTRY: readonly SchemaRegistryEntry[] = [
  {
    name: "robot",
    title: "FleetOS Robot",
    description:
      "Vendor-neutral registry record for one robot: capability ontology, command allow-list, and compliance block. The scheduler's entire view of a device.",
    schema: RobotSchema,
  },
  {
    name: "robot-capability",
    title: "FleetOS Robot Capability",
    description:
      "What a robot can do, physically and operationally. The scheduler reads this record, never vendor specifics.",
    schema: RobotCapabilitySchema,
  },
  {
    name: "compliance-block",
    title: "FleetOS Compliance Block",
    description:
      "Per-device compliance posture: FCC authorization status, firmware-update window, place of production, data residency, and data-flow profile.",
    schema: ComplianceBlockSchema,
  },
  {
    name: "data-flow-profile",
    title: "FleetOS Data Flow Profile",
    description:
      "Where a robot's telemetry goes: the OEM cloud it traverses, the jurisdictions it transits, and the minimized telemetry field set.",
    schema: DataFlowProfileSchema,
  },
  {
    name: "fleet-task",
    title: "FleetOS Task",
    description:
      "One unit of schedulable work with its customer SLA window and capability requirements.",
    schema: FleetTaskSchema,
  },
  {
    name: "dispatch-plan",
    title: "FleetOS Dispatch Plan",
    description:
      "Scheduling-core output: robot-task assignments with projected on-time completion, expected interventions, and minimum battery reserve.",
    schema: DispatchPlanSchema,
  },
  {
    name: "schedule-entry",
    title: "FleetOS Schedule Entry",
    description:
      "One robot-task assignment inside a dispatch plan, with start time, duration estimate, and risk notes.",
    schema: ScheduleEntrySchema,
  },
  {
    name: "telemetry-sample",
    title: "FleetOS Telemetry Sample",
    description:
      "One normalized telemetry sample emitted by an adapter, absorbed into the digital shadow.",
    schema: TelemetrySampleSchema,
  },
  {
    name: "fault-event",
    title: "FleetOS Fault Event",
    description:
      "One normalized fault event from the cross-vendor fault taxonomy, ready for fleet-health classification.",
    schema: FaultEventSchema,
  },
  {
    name: "intervention",
    title: "FleetOS Intervention",
    description:
      "A recorded human touch on the fleet: pause, resume, reassign, or a device-agent proposal decision.",
    schema: InterventionSchema,
  },
  {
    name: "audit-event",
    title: "FleetOS Audit Event",
    description:
      "One append-only audit entry — the compliance and incident evidence base for every state change.",
    schema: AuditEventSchema,
  },
  {
    name: "constraint-pack",
    title: "FleetOS Constraint Pack",
    description:
      "A versioned pack of external constraints (energy tariff, weather, site rules, SLA) consumed by the scheduler's constrained optimum, with human-approval provenance.",
    schema: ExternalConstraintPackSchema,
  },
  {
    name: "site-selector",
    title: "FleetOS Site Selector",
    description:
      "Scope selector for a constraint pack: sites and/or robot kinds; an empty selector applies fleet-wide.",
    schema: SiteSelectorSchema,
  },
] as const;

export type SchemaName = (typeof SCHEMA_REGISTRY)[number]["name"];

/** Builds every published JSON Schema document, keyed by registry name. */
export function buildJsonSchemas(): Record<SchemaName, JsonSchemaDocument> {
  const out = {} as Record<SchemaName, JsonSchemaDocument>;
  for (const entry of SCHEMA_REGISTRY) {
    // The document is plain JSON by construction; round-trip through
    // JSON.stringify to normalize and to hand us a plain record to edit.
    const generated = JSON.parse(
      JSON.stringify(z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" })),
    ) as JsonSchemaDocument;
    out[entry.name] = {
      ...generated,
      $schema: JSON_SCHEMA_DIALECT,
      $id: `${entry.name}.schema.json`,
      title: entry.title,
      description: entry.description,
    };
  }
  return out;
}
