/**
 * FleetOS capability ontology — the contract package.
 *
 * Consumers use the Zod schemas for runtime validation and the inferred
 * domain types; non-TS consumers use the generated JSON Schema documents
 * under schemas/ (exposed via the "./schemas/*" export). Schemas change
 * only in dedicated PRs; evolution within major 1 is additive.
 */

export * from "./version.js";
export * from "./primitives.js";
export * from "./capability.js";
export * from "./compliance.js";
export * from "./robot.js";
export * from "./task.js";
export * from "./plan.js";
export * from "./telemetry.js";
export * from "./fault.js";
export * from "./intervention.js";
export * from "./audit.js";
export * from "./constraints.js";
export * from "./json-schema.js";
