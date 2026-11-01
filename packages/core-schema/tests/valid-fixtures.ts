import type { SchemaName } from "../src/json-schema.js";

import {
  exampleAuditEvent,
  exampleConstraintPack,
  exampleDispatchPlan,
  exampleFleetTask,
  exampleFaultEvent,
  exampleIntervention,
  exampleRobotMower,
  exampleRobotScrubber,
  exampleTelemetrySample,
} from "../src/fixtures.js";

/**
 * Valid examples for every published schema, keyed by registry name. The
 * record-level fixtures double as sources for the nested schemas, so the
 * published artifacts stay consistent with the composite records.
 */
export const VALID_FIXTURES: Record<SchemaName, readonly unknown[]> = {
  robot: [exampleRobotMower, exampleRobotScrubber],
  "robot-capability": [exampleRobotMower.capabilities, exampleRobotScrubber.capabilities],
  "compliance-block": [exampleRobotMower.compliance, exampleRobotScrubber.compliance],
  "data-flow-profile": [exampleRobotMower.compliance.dataFlow],
  "fleet-task": [exampleFleetTask],
  "dispatch-plan": [exampleDispatchPlan],
  "schedule-entry": [exampleDispatchPlan.assignments[0]!],
  "telemetry-sample": [exampleTelemetrySample],
  "fault-event": [exampleFaultEvent],
  intervention: [exampleIntervention],
  "audit-event": [exampleAuditEvent],
  "constraint-pack": [exampleConstraintPack],
  "site-selector": [exampleConstraintPack.appliesTo, {}],
};

/** Throws for a registry name with no fixtures — a coverage bug, never silently empty. */
export function fixturesFor(name: SchemaName): readonly unknown[] {
  const fixtures = VALID_FIXTURES[name];
  if (fixtures === undefined) {
    throw new Error(`No valid fixtures registered for schema "${name}"`);
  }
  return fixtures;
}
