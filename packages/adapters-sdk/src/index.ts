/**
 * FleetOS adapter SDK (spec D1) — the RobotAdapter contract, the shared
 * lifecycle base, command gating, the reference in-memory adapter, and the
 * four first-batch simulator vendors. FleetOS core never imports vendor
 * code; vendor integrations implement RobotAdapter and are held to one
 * contract suite.
 *
 * The vitest-based contract harness is NOT re-exported here — it would drag
 * vitest into every non-test consumer (the scheduler bench CLI, apps).
 * Import it from the dedicated subpath: `@fleetos/adapters-sdk/contract`.
 */

export * from "./adapter.js";
export * from "./clock.js";
export * from "./gating.js";
export * from "./lifecycle.js";
export * from "./testing/in-memory-adapter.js";
export * from "./simulators/index.js";
