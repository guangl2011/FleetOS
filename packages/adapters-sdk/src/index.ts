/**
 * FleetOS adapter SDK (spec D1) — the RobotAdapter contract, the shared
 * lifecycle base, command gating, the adapter contract test harness, the
 * reference in-memory adapter, and the four first-batch simulator vendors.
 * FleetOS core never imports vendor code; vendor integrations implement
 * RobotAdapter and are held to one contract suite.
 */

export * from "./adapter.js";
export * from "./clock.js";
export * from "./gating.js";
export * from "./lifecycle.js";
export * from "./contract/define-adapter-contract-tests.js";
export * from "./testing/in-memory-adapter.js";
export * from "./simulators/index.js";
