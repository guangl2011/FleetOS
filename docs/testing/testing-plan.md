# FleetOS Testing Plan (Deliverable D3)

Circunar Inc. · FleetOS · SBIR Phase I Concept Build

This is the testing plan for the FleetOS MVP defined in the approved product spec
(`art_s9VfpgZW`, deliverable D3). It is a living document: each implementing task for a
package below is required to deliver the tests this plan names for it. Until a package
lands, its test directory does not exist yet; the CI gate column states which workflow
gates that class the moment it does. Every CI gate named in this document maps to a real
workflow file in `.github/workflows/` — the doc-lint check described in §8 enforces both
this plan's completeness and that mapping in CI.

## 0. Test-class summary

| # | Test class | Owner package(s) | CI gate |
|---|-----------|------------------|---------|
| 1 | Unit tests per package | every package | CI — quality job (`.github/workflows/ci.yml`) |
| 2 | Adapter contract tests | `packages/adapters-sdk` + all four simulators | CI — quality job (`.github/workflows/ci.yml`) |
| 3 | Deterministic benchmark scenarios (seeded faults, connectivity degradation) | `packages/scheduler`, `packages/world-model` | CI — quality job (`.github/workflows/ci.yml`) |
| 4 | Scheduler-vs-baseline comparison protocol (quality deltas, confidence-calibration error, energy-cost axis, bounded-autonomy checks) | `packages/scheduler`, `packages/world-model`, `packages/constraints`, `packages/device-agents` | CI — quality job (`.github/workflows/ci.yml`) |
| 5 | Data-compliance checks | `packages/core-schema`, `apps/api`, `packages/fleet-health` | CI — quality job (`.github/workflows/ci.yml`) |
| 6 | API integration tests (fault → exception → intervention → audit trail; degraded mode) | `apps/api` | CI — quality job (`.github/workflows/ci.yml`) |
| 7 | Manual console QA scripts | `apps/console` | not a CI gate — run per the visual-evidence rule; screenshot/recording captured against the tested head SHA |
| 8 | Doc-lint (this plan) | `tests/docs` | CI — quality job (`.github/workflows/ci.yml`) |
| — | Secret scanning | repository-wide | Security — gitleaks job (`.github/workflows/security.yml`) |

Deliberately out of scope for the MVP: end-to-end tests against physical robots (no
physical-robot dependency anywhere in the MVP), load testing, browser unit tests for the
console (console correctness is covered by API integration tests plus the manual QA
scripts in §7), and mutation testing.

## 1. Testing principles

1. **Determinism above all.** Every scenario, simulator fault profile, and benchmark run
   is driven by an explicit integer seed and fixed scenario file. No wall-clock, no
   network, no random-number use outside the seeded generator. Any test that cannot be
   made deterministic is a manual QA script (§7), not a CI test.
2. **Contract-first.** The adapter contract suite (§3) and the capability-schema suite
   (§2.1) are written against the shared contracts, so a simulator that satisfies them is
   interchangeable with the physical OEM integration that will implement the same
   interface later.
3. **Claims are measured, not asserted.** The spec's research claims (risk-aware planner
   beats the rule-based baseline; the world model knows what it does not know; constraint
   packs shape real schedules; device-agent autonomy is bounded) each map to a specific
   assertion in the comparison protocol (§5) with a numeric pass bar. If the bar fails,
   the feature is not done.
4. **No silent failures.** Tests assert on errors and error classes, never on absence of
   output. A swallowed error is a bug (root repo principle), and the tests are written to
   catch exactly that shape.
5. **One command reproduces anything.** Every CI-gated test class runs via `pnpm test`
   from the repo root; every benchmark scenario is reproducible from the doc alone using
   the exact commands given in §4–§5.

## 2. Unit strategy per package

All packages use Vitest (workspace `vitest.config.ts` includes `packages/**/*.test.ts`
and `apps/**/*.test.ts`) and run in one `pnpm test` pass under the CI quality job.
Unit tests colocate with source as `<module>.test.ts`. Naming convention:
`describe` blocks named after the exported unit under test; scenario IDs referenced in
this plan are quoted verbatim in assertions.

### 2.1 `packages/core-schema`

- Capability record v1 parse/serialize round-trip for all three robot kinds
  (`mower`, `scrubber`, `inspection-rover`).
- Invalid-reject cases, one per failure mode: missing `commands` entry, unknown `kind`,
  `confidence` outside 0..1, negative `batteryWh`, `chargeHours` not a 2-tuple in range,
  wrong `schemaVersion`, unknown task type.
- Compliance block validation (see §6): missing production origin, unknown FCC
  authorization status value, data-flow profile without a jurisdiction.
- Additive-evolution guard: a schema change test asserts that removing or re-typing any
  exported field fails — v1 fields may only be added to.

### 2.2 `packages/adapters-sdk` (+ the four simulator adapters)

- Per-simulator unit tests: seeded fault-profile injection produces the seeded fault
  sequence; command ticket lifecycle (send → ticket → terminal state) for every command
  in the allow-list; telemetry event shape.
- The shared contract suite itself is specified in §3; it is the primary correctness
  gate for this package, and each adapter runs it in CI.

### 2.3 `packages/world-model`

- Digital-shadow absorption: feed a scripted telemetry/fault stream, assert the
  snapshot reflects battery state, task progress, and fault state per robot.
- Confidence estimation: inject stale telemetry, then degraded telemetry, then a
  comms-loss; assert `confidence(robotId)` drops monotonically and recovers on fresh
  data. Assert the scheduler-facing contract (down-weighting behavior) in §5.
- Prediction seam: with fixed scenario seeds, `predict(horizonMinutes)` returns the same
  predicted futures across runs (determinism check).

### 2.4 `packages/constraints`

- Constraint-pack validation: versioned pack parses; unknown `source`, unapproved pack
  (`humanApproved: false`), or malformed cost curve is rejected by the loader.
- Selector semantics: a pack scoped to one site/time window must not affect robots
  outside the selector.
- Hard vs soft constraint classification: noise-ordinance and access-hour windows are
  hard; demand-charge curves and SLA weights are soft cost terms.

### 2.5 `packages/device-agents`

- Fault self-diagnosis: each normalized fault class (`BATTERY`, `STUCK`,
  `SENSOR_DEGRADED`, `COMMS_LOST`, `WEATHER_HOLD`, `MAINTENANCE_DUE`) produces a
  diagnosis with a severity and a suggested recovery.
- Envelope rejection: a proposed local replan that moves work outside the assigned
  envelope (order swaps beyond the window, timing shifts violating a hard constraint)
  is rejected; the proposal never reaches the audit trail as an action.
- Bounded autonomy: no code path in the agent issues a robot command; recovery executes
  only after human approval through the audited command path. (Full behavioral checks
  are in §5.4; these unit tests pin the type-level and per-case behavior.)

### 2.6 `packages/scheduler`

- `planSchedule` respects the objective weights on hand-built micro-fleets (one robot,
  two tasks; battery floor forcing a recharge; unresolvable conflict producing a
  `riskNotes` entry).
- `ruleBasedBaseline` implements the defined rule (nearest-available-robot, fixed
  battery threshold) and nothing smarter — the baseline must stay beatable by design.
- Constraint-pack integration: with a peak-price tariff pack applied, charging and
  energy-heavy tasks shift off-peak in the produced plan (asserted structurally here;
  measured on cost in §5.3).

### 2.7 `packages/fleet-health`

- Fault classification and severity mapping for all six normalized fault classes.
- Exception-queue lifecycle: fault → exception opens; `HELD` task state applied and
  released.
- Degraded-mode logic: adapter or telemetry loss marks affected robots `DEGRADED` and
  stops feeding their telemetry to the optimizer (scheduler-side behavior asserted in
  §5.2).
- Audit-trail appender: every state change appends exactly one record with operator,
  action, timestamp, and plan version in effect; the trail is append-only (no update or
  delete path exists).

### 2.8 `apps/api`

- Endpoint-level tests with an in-process Fastify instance and SQLite fixture: fleet
  listing, task CRUD, schedule fetch, exception queue, intervention actions, benchmark
  report endpoint.
- Data-residency and minimization enforcement (§6.2, §6.3).

### 2.9 `apps/console`

- No browser-unit framework in the MVP. Console correctness is pinned by the API
  integration tests it consumes and verified manually per §7; rendering logic that is
  cheap and meaningful to unit-test (schedule-board plan-version gating, compliance
  badge derivation) lives in pure functions with colocated unit tests.

## 3. Adapter contract tests

One shared contract suite in `packages/adapters-sdk/src/contract/`, run against **all
four** simulator adapters (Greenworks mower, 九号/Navimow mower, Husqvarna mower via its
Open API model, and the scrubber). Identical suite, identical assertions, zero
per-adapter overrides — a per-adapter skip is a failing PR by definition. CI gate:
quality job (`.github/workflows/ci.yml`).

The suite asserts, for each adapter:

1. `listRobots()` returns a valid capability record per robot (schema-validated, §2.1)
   with the expected vendor and kind.
2. `subscribeTelemetry` delivers a normalized `TelemetryEvent` stream for a scripted
   scenario: monotonic sequence, required fields present, units as specified in the
   schema package.
3. `sendCommand` returns a ticket for every command in the adapter's allow-list, and the
   ticket reaches a terminal state via telemetry or poll; a command **outside** the
   allow-list is rejected before reaching the simulator.
4. `subscribeFaults` emits each of the six normalized fault classes from the seeded
   fault profile, with vendor specifics fully normalized away.
5. `healthCheck()` reflects injected health states.

Fault profiles are injected per scenario seed, so the contract suite also proves the
adapters honor the determinism contract of §1.

## 4. Deterministic benchmark scenarios

Scenarios are versioned JSON files under `packages/scheduler/bench/presets/`, each
naming: fleet composition (which simulators, robot count), task set, a seeded fault
schedule (which fault, which robot, at which step), and an optional connectivity-
degradation schedule. The generator is seeded so the same preset always produces the
same run. The preset set at MVP acceptance:

- `seed-01-battery-faults` — mixed fleet, staged BATTERY and MAINTENANCE_DUE faults.
- `seed-02-stuck-and-sensor` — STUCK and SENSOR_DEGRADED faults requiring intervention.
- `seed-03-comms-degradation` — intermittent connectivity and partial telemetry loss
  (docx §7 scenario): a window in which affected adapters drop telemetry and the
  degraded-mode path must engage.
- `seed-04-tariff-and-noise` — peak-price tariff pack plus a noise-ordinance hard
  window, to exercise the constraint-pack axes.

Reproduce any scenario verbatim from the doc:

```sh
pnpm install
pnpm --filter @fleetos/scheduler bench:scenario -- --scenario=seed-03-comms-degradation
```

The command writes a JSON report (per-scenario metrics for both schedulers) to stdout
and `bench/reports/<scenario>.json`. CI re-runs all four presets in the quality job and
asserts the report invariants in §5 — the benchmark is a test, not an artifact you run
by hand.

## 5. Scheduler-vs-baseline comparison protocol

Both schedulers (`planSchedule` and `ruleBasedBaseline`) consume the identical scenario
files, fleet capability records, world-model snapshot, objective, and constraint packs.
The comparison harness in `packages/scheduler/src/bench/` reports, per scenario, the
deltas below. Pass bars come from the concept doc §7 and are the MVP acceptance bars;
the quality job fails if any is missed.

### 5.1 Quality deltas

- On-time completion: risk-aware planner ≥ **+15%** over the rule-based baseline.
- Interventions per 100 robot-hours: risk-aware planner ≥ **−20%** vs baseline.
- Adapter interfaces in play: **3** mower interfaces minimum across the scenario set
  (plus the scrubber for cross-category readiness).

### 5.2 World-model confidence calibration

The benchmark reports **calibration error** alongside the quality deltas: predicted
confidence vs observed correctness binned across runs. Assert: calibration error within
the bar set for the MVP (reported in the benchmark output; the numeric bar is finalized
when `packages/world-model` lands and recorded here by that task), and that under the
`seed-03-comms-degradation` scenario the scheduler excludes `DEGRADED` robots' telemetry
from optimization — stale data must not improve a plan.

### 5.3 Energy-cost and constraint-satisfaction axis

With `seed-04-tariff-and-noise`:

- Energy cost is reported per scenario for both schedulers; the planner must show
  measurable off-peak shifting vs baseline under the tariff pack.
- Constraint satisfaction: zero hard-constraint violations (no mowing task inside the
  noise-ordinance window, no work outside site-access hours) is a hard pass/fail for
  **both** schedulers — constraint packs are not optional for either.

### 5.4 Bounded-autonomy checks (device agents)

Run against the agent layer during the benchmark scenarios; every check is CI-gated:

- No agent proposal falls outside its assigned envelope (order swaps within the window
  and timing shifts that respect hard constraints are the entire permitted space).
- No recovery command executes without a recorded human approval in the audit trail.
- Every agent proposal (accepted or rejected) appears in the audit trail with the plan
  version in effect.
- Falsifiability check: with the policy seam set to a deliberately rule-breaking stub
  policy, the harness must reject it — proving the boundary is enforced by the system,
  not by the current policy's good behavior.

## 6. Data-compliance checks

Driven by the FCC Covered List posture in the approved spec. CI gate: quality job
(`.github/workflows/ci.yml`).

### 6.1 Per-device compliance block

- Every capability record carries a complete compliance block (production origin, FCC
  authorization status, firmware-update eligibility window, data-flow profile with
  jurisdiction). Schema tests (§2.1) reject incomplete blocks.
- API fleet listing surfaces the cross-border data-flow profile per device — asserted
  by an API integration test, so the console can render it (manual QA script M-4).

### 6.2 Data residency and telemetry minimization

- Residency config: the API is configured with a storage region; an integration test
  asserts persistence rejects or flags records whose configured region does not match.
- Minimization: the API accepts a declared minimal telemetry field set per adapter and
  **rejects** non-minimal fields with a typed error; a test sends an over-wide payload
  and asserts the rejection.

### 6.3 Audit-trail completeness

- Integration test: inject a BATTERY fault → assert exception queued → PAUSE + RESUME
  via the intervention surface → assert the audit trail contains every step (operator,
  action, timestamp, plan version) and nothing else mutated state silently.
- Append-only property: no API or package code path can update or delete an audit
  record (type-level plus a test that the persistence layer exposes no such operation).

## 7. Manual console QA scripts

The console demo path is verified by hand per the visual-evidence rule (screenshots and
a short recording captured against the tested head SHA, submitted via
`obvious autobuild upload`). Each script below is a step list an operator can follow;
the capturing worker records `tc-N` IDs matching the PR's acceptance criteria.

- **M-1 Connect and survey.** Open the console; verify the fleet list shows all three
  mower fleets and the scrubber with capability and compliance badges.
- **M-2 Approve a schedule.** Load a plan for `seed-01-battery-faults`; verify
  assignments, risk notes, and projected metrics render; approve the plan.
- **M-3 Handle an exception.** With the fault stream running, verify the BATTERY fault
  opens an exception; pause and resume the affected robot; verify the audit view shows
  the full path.
- **M-4 Compliance surfacing.** Open a device detail view; verify production origin,
  FCC status, firmware-update window, and cross-border data-flow profile are visible.
- **M-5 Constraint packs.** Apply the tariff pack and the noise-ordinance window;
  verify the schedule board shows shifted charging/tasks and marks the hard window.
- **M-6 Agent proposals.** Verify a device-agent proposal appears with its diagnosis,
  that out-of-envelope proposals are visibly rejected, and that approval is required
  before any recovery executes.

A failed manual script is a bug against this plan; the fix task references the script ID.

## 8. Doc-lint: this plan is CI-enforced

`tests/docs/testing-plan.doc.test.ts` runs in the quality job and asserts:

1. Every D3 test class named in §0 is present in this document as a section.
2. Every CI gate referenced in this document maps to an existing workflow file under
   `.github/workflows/`.

If you add a test class here, add it to the doc-lint expectation list in the same PR;
if you reference a new workflow, create the workflow in the same PR. The doc-lint test
fails the build on drift in either direction.

## 9. What "done" means for a testing task

A package's testing work is complete when: its unit tests and any shared-contract
obligations pass in CI; its rows in §0 name the right gate and owner; and any claim it
makes about scheduler, world-model, constraint, or agent behavior is asserted by the
comparison protocol of §5 with a number, not an adjective.
