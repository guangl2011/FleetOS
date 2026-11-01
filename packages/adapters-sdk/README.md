# @fleetos/adapters-sdk

FleetOS adapter SDK (spec D1): the contract that turns a vendor-specific robot
integration into normalized core-schema types — plus the lifecycle engine and
the shared test harness every adapter must pass.

## Contents

- **`RobotAdapter`** (`src/adapter.ts`) — the normalization contract:
  capability records, telemetry stream, fault stream, lifecycle events, and
  the ticket-based command path. Members are function properties so
  `strictFunctionTypes` checks implementations contravariantly.
- **`BaseRobotAdapter`** (`src/lifecycle.ts`) — the connect / reconnect /
  degrade state machine, boundary validation (telemetry, faults, and robot
  records are Zod-validated before fan-out), subscriber fan-out, and command
  gating. Vendor integrations implement five `do*` hooks; they cannot bypass
  gating or emit unvalidated records.
- **Command gating** (`src/gating.ts`) — `isCommandPermitted`,
  `assertCommandPermitted`, `unpermittedCommands`.
- **`defineAdapterContractTests`** (`src/contract/`) — the shared contract
  suite (testing plan §3) that any adapter runs against itself: normalization,
  monotonic telemetry, ticket lifecycle, allow-list gating, six-class fault
  emission, degraded health, and reconnect-without-resubscription. Scenario
  drivers are required options — a per-adapter skip is a failing PR.
- **`InMemoryAdapter`** (`src/testing/`) — the deterministic reference
  adapter and the self-check target for the contract suite.

## Writing an adapter

```ts
import { defineAdapterContractTests, InMemoryAdapter } from "@fleetos/adapters-sdk";

class MySimAdapter extends BaseRobotAdapter {
  /* implement the do* hooks */
}

defineAdapterContractTests({
  name: "my-sim",
  createAdapter: () => new MySimAdapter(),
  expectedVendor: "my-sim",
  expectedKinds: ["mower"],
  runScriptedScenario: async (adapter) => {
    /* drive telemetry */
  },
  injectFaultProfile: async (adapter) => {
    /* emit all six fault classes */
  },
  dropTransport: async (adapter) => {
    /* force the reconnect path */
  },
  degradeAdapter: async (adapter) => {
    /* enter degraded state */
  },
});
```

Non-goals (repo guardrails): no physical-robot control, no teleoperation
surface — the dispatch plane is pause/resume/reassign only.
