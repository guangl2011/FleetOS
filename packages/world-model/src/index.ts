/**
 * FleetOS world model (spec D1) — the digital shadow over the normalized
 * fleet: per-robot slices (state, confidence, position/battery/task, active
 * constraint packs) exposed to the scheduler and to device agents, per-robot
 * confidence estimation, calibration metrics (Brier/ECE), and a typed
 * prediction seam the Phase I learned predictor swaps into without touching
 * a consumer.
 */

export * from "./errors.js";
export * from "./clock.js";
export * from "./events.js";
export * from "./state.js";
export * from "./confidence.js";
export * from "./packs.js";
export * from "./calibration.js";
export * from "./predictor.js";
export * from "./shadow.js";
