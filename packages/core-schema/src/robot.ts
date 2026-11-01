import { z } from "zod";

import { CommandPermissionSchema, RobotCapabilitySchema, RobotKindSchema } from "./capability.js";
import { ComplianceBlockSchema } from "./compliance.js";
import { ConfidenceSchema, EntityIdSchema, SchemaVersionSchema } from "./primitives.js";

/**
 * The vendor-neutral registry record for one robot — the scheduler's entire
 * view of a device (the spec's RobotCapabilityRecord plus the compliance
 * block). Everything vendor-specific stays behind the adapter.
 */
export const RobotSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  robotId: EntityIdSchema,
  vendor: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  /** Drives compatibility checks (spec field comment). */
  firmwareVersion: z.string().min(1).max(64),
  kind: RobotKindSchema,
  capabilities: RobotCapabilitySchema,
  /** Explicit allow-list: the dispatch plan may only send listed commands. */
  commands: z.array(CommandPermissionSchema).min(1),
  /** Adapter-reported data quality in [0, 1]; the world model re-derives its own. */
  confidence: ConfidenceSchema,
  compliance: ComplianceBlockSchema,
});

export type Robot = z.infer<typeof RobotSchema>;
