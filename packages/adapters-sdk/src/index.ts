/**
 * FleetOS adapter SDK (spec D1) — the RobotAdapter contract, the shared
 * lifecycle base, command gating, the adapter contract test harness, and the
 * reference in-memory adapter. FleetOS core never imports vendor code; vendor
 * integrations implement RobotAdapter and are held to one contract suite.
 */

export * from "./adapter.js";
export * from "./clock.js";
export * from "./gating.js";
export * from "./lifecycle.js";
export * from "./contract/define-adapter-contract-tests.js";
export * from "./testing/in-memory-adapter.js";
