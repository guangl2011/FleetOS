/**
 * First-batch simulator vendors (spec D1). Each exports its adapter factory,
 * fleet registry, and scripted-scenario drivers behind the same RobotAdapter
 * contract — mowers from the founder-confirmed OEMs (Greenworks, 九号/Navimow,
 * Husqvarna) plus one next-category scrubber proving cross-kind readiness.
 */
export * from "./greenworks/adapter.js";
export * from "./greenworks/device.js";
export * from "./greenworks/normalize.js";
export * from "./greenworks/registry.js";

export * from "./navimow/adapter.js";
export * from "./navimow/device.js";
export * from "./navimow/normalize.js";
export * from "./navimow/registry.js";

export * from "./husqvarna/adapter.js";
export * from "./husqvarna/device.js";
export * from "./husqvarna/normalize.js";
export * from "./husqvarna/registry.js";

export * from "./scrubber/adapter.js";
export * from "./scrubber/device.js";
export * from "./scrubber/normalize.js";
export * from "./scrubber/registry.js";

export * from "./shared/device-core.js";
export * from "./shared/fault-schedule.js";
export * from "./shared/fault-sequencer.js";
export * from "./shared/registry.js";
export * from "./shared/seeded-rng.js";
