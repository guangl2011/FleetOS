/**
 * Injectable clock for the world model. Same shape as the adapter SDK's
 * `Clock` (structurally compatible — no cross-package dependency): real
 * deployments inject `() => new Date().toISOString()`, while simulators and
 * tests inject a ManualClock so shadow behavior is deterministic (repo
 * convention: no unseeded wall-clock in tests).
 */
export interface WorldClock {
  now(): string;
}

/** Default production clock. Tests, simulators, and benchmarks always inject one. */
export function systemClock(): WorldClock {
  return { now: () => new Date().toISOString() };
}
