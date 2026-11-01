/**
 * FleetOS fleet health (spec fleet-health chapter) — the operator-facing
 * health layer over the normalized event stream: fault severity
 * classification (fed by adapter fault profiles and device-agent
 * AgentDiagnosis), the exception queue with HELD task state, the append-only
 * audit-trail store (operator command, system action, timestamp, plan
 * version in effect — the compliance evidence base), and degraded-mode
 * logic: comms loss marks the robot DEGRADED and its telemetry is excluded
 * from optimization until a fresh sample proves the link back. Device
 * agents propose, humans approve; no remote-driving surface exists here.
 */

export * from "./errors.js";
export * from "./exceptions.js";
export * from "./classify.js";
export * from "./audit.js";
export * from "./degraded.js";
export * from "./engine.js";
