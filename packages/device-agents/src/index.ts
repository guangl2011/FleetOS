/**
 * FleetOS device agents (spec D1, agentic operations) — one deterministic
 * policy agent per device, derived from that device's digital-twin slice:
 * the agent observes its shadow state and assigned envelope, self-diagnoses
 * faults with a severity and a suggested recovery, and proposes local
 * replans strictly inside its envelope (task swaps within the swap set,
 * start shifts within tolerance and clear of hard constraint windows).
 * Recovery is human-approved through the audited command path; every
 * proposal — accepted or rejected — lands in the audit trail. The policy
 * object is a typed seam: deterministic-v1 ships in the MVP, LLM reasoners
 * swap in during Phase I through the same interface. Device agents never
 * hold remote-driving authority — the dispatch surface is pause/resume/
 * reassign plus human-approved recovery, and robot-local safety stays
 * authoritative.
 */

export * from "./errors.js";
export * from "./audit.js";
export * from "./diagnosis.js";
export * from "./replan.js";
export * from "./recovery.js";
export * from "./policy.js";
export * from "./agent.js";
