# FleetOS MVP Test Plan — Shipped-MVP Validation

Circunar Inc. · FleetOS · SBIR Phase I Concept Build

This is the validation plan for the FleetOS MVP **as shipped** — the state of the
repository after PRs #1–#14 landed all spec deliverables (schema, constraints, adapters,
world model, scheduler, device agents, fleet health, API, console). It builds on the D3
testing plan ([`testing-plan.md`](./testing-plan.md)) rather than duplicating it: D3
defined the _testing contract_ each implementing task had to satisfy; this document
defines _how you prove the delivered system works end to end_, package by package, and
what must hold for a release candidate.

Where D3 speaks in future tense ("until a package lands, its test directory does not
exist yet"), this document speaks in the present tense against the live tree. Numbers in
it are reproducible from the commands given — every scenario is seeded, so the same SHA
always produces the same report.

Maintenance rule: this is a living document. When tests are added, the per-package table
in §1 is updated in the same PR (the counts are checked against `pnpm test` output);
when the benchmark scenario set changes, §3 is updated in the same PR.

## 1. Per-package verification map (408 tests)

`pnpm test` from the repo root runs **408 tests across 41 files**, all green on the
shipped MVP head. The table maps each deliverable package to its verification points
(what the tests actually pin) and its test files with counts. CI gate for every row:
the quality job (`.github/workflows/ci.yml`).

| Package                  | Verification points (what is proven)                                                                                                                                                                                                                                                                              | Test files (count)                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core-schema`   | Capability/telemetry/fault/task schemas round-trip for all three robot kinds; invalid-reject per failure mode; compliance-block validation; Zod ↔ Draft 2020-12 JSON Schema parity; additive-evolution guard                                                                                                      | `tests/round-trip.test.ts` (47), `tests/parity.test.ts` (40) — **87**                                                                                                                                                                                                                                                                                                                                                            |
| `packages/constraints`   | Versioned pack validation and approval-gated ingestion; selector scoping (a pack must not leak outside its site/time window); hard vs soft classification (noise-ordinance and access hours are hard; tariff curves and SLA weights are soft cost terms)                                                          | `tests/constraints.test.ts` (25) — **25**                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/adapters-sdk`  | Shared contract suite run against all four OEM simulators with zero per-adapter skips; capability-gated command allow-list; ticket lifecycle to terminal state; seeded fault-profile determinism (incl. one comms blackout); telemetry normalization; health states; lifecycle gating                             | `tests/contract/adapter-contract.test.ts` (15), `tests/contract/scenario-determinism.test.ts` (16), `tests/contract/greenworks-sim.test.ts` (8), `tests/contract/navimow-sim.test.ts` (9), `tests/contract/husqvarna-sim.test.ts` (9), `tests/contract/scrubber-sim.test.ts` (9), `tests/in-memory-adapter.test.ts` (11), `tests/lifecycle.test.ts` (12), `tests/adapter.types.test.ts` (5), `tests/gating.test.ts` (5) — **99** |
| `packages/world-model`   | Digital-shadow absorption of scripted telemetry/fault streams; per-robot confidence degrades monotonically under stale/degraded/lost telemetry and recovers on fresh data; calibration error reported; deterministic prediction seam; seam-swap test proving the prediction seam is replaceable                   | `tests/shadow.test.ts` (8), `tests/confidence.test.ts` (12), `tests/calibration.test.ts` (3), `tests/packs.test.ts` (6), `tests/predictor.test.ts` (7), `tests/seam-swap.test.ts` (3) — **39**                                                                                                                                                                                                                                   |
| `packages/scheduler`     | Full benchmark suite clears the docx §7 pass bars (§3 below); both schedulers consume identical seeded worlds and reproduce metrics exactly; zero hard-window violations per scenario; summary report with PASS verdict                                                                                           | `tests/benchmark.test.ts` (6) — **6**                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/device-agents` | Per-fault-class diagnosis with severity and suggested recovery; replan proposals confined to the assignment envelope (out-of-envelope rejected and never recorded as actions); recovery executes only after human approval; policy-seam falsifiability stub is rejected by the harness                            | `tests/diagnosis.test.ts` (12), `tests/replan.test.ts` (15), `tests/recovery.test.ts` (7), `tests/agent.test.ts` (7), `tests/policy-seam.test.ts` (2) — **43**                                                                                                                                                                                                                                                                   |
| `packages/fleet-health`  | Fault classification and severity for all six normalized classes; exception-queue lifecycle (fault → exception → HELD → release); audit-trail appender (append-only, one record per state change with operator/action/timestamp/plan version); degraded-mode telemetry exclusion                                  | `tests/classify.test.ts` (7), `tests/engine.test.ts` (10), `tests/audit.test.ts` (5), `tests/degraded.test.ts` (4), `tests/integration.test.ts` (3) — **29**                                                                                                                                                                                                                                                                     |
| `apps/api`               | Endpoint-level integration tests on an in-process Fastify instance over SQLite: fleet/task/schedule/exception/intervention/benchmark/audit surfaces; residency enforcement; telemetry minimization (over-wide payloads rejected with a typed error); the fault → exception → intervention → audit chain (D3 §6.3) | `test/api.integration.test.ts` (19) — **19**                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/console`           | Pure-function and component tests for schedule-board plan-version gating, compliance-badge derivation, and every console panel (fleet list/map, exceptions, proposal review, benchmark view) rendered against API-shaped fixtures                                                                                 | `src/components/FleetList.test.tsx` (4), `src/components/FleetMap.test.tsx` (5), `src/components/ScheduleBoard.test.tsx` (3), `src/components/ExceptionQueue.test.tsx` (5), `src/components/ProposalReview.test.tsx` (5), `src/components/CompliancePanel.test.tsx` (3), `src/components/BenchmarkView.test.tsx` (4) — **29**                                                                                                    |
| Repo root (`tests/`)     | Smoke suites; D2 doc-lint (product plan + design doc sections); D3 doc-lint (test classes, pass bars, scenario names, workflow-file existence)                                                                                                                                                                    | `tests/smoke.test.ts` (3), `tests/docs-checklist.test.ts` (10), `tests/docs/testing-plan.doc.test.ts` (19) — **32**                                                                                                                                                                                                                                                                                                              |
| **Total**                |                                                                                                                                                                                                                                                                                                                   | **408**                                                                                                                                                                                                                                                                                                                                                                                                                          |

Running the whole map: `pnpm install && pnpm test` (≈9 s wall on the reference laptop;
the scheduler benchmark tests dominate at ~7 s by design — they re-run the seeded
scenario set).

## 2. End-to-end demo path (simulator → API → console)

This is the shipped demo the spec's acceptance criterion ("operator console usable for
the demo path") points at. The demo harness in `apps/api/src/demo.ts` boots the **real
API** over the **real simulator adapters** — no mocks — with a shared `ManualClock`,
seeds a demo day over the public API (tasks, a tariff constraint pack, benchmark runs),
then keeps the fleet alive: a tick loop advances sim time, a scripted battery fault
opens the first exception, and a committed-plan watcher drops a `WEATHER_HOLD` on a
mower whose assignment has not started yet — the state a device agent needs to propose
a bounded replan.

```sh
pnpm install
pnpm --filter @fleetos/api demo        # API + 4 simulators on 127.0.0.1:8737
pnpm --filter @fleetos/console dev     # Vite; proxies /api → 127.0.0.1:8737
```

Open the printed Vite URL. The walkthrough below is the demo-day script; every step
names the surface you interact with and what you must see. A step that does not produce
the stated observation is a bug against this plan.

1. **Fleet survey** — Fleet list and fleet map show all four simulators (three mower
   fleets plus the scrubber) with capability and compliance badges. Underlying API:
   `GET /fleet/robots`, `GET /fleet/sites`.
2. **Seed and plan** — The harness has created the demo tasks and the tariff pack
   (`POST /tasks`, `POST /constraint-packs` at boot). Open the schedule board: the
   risk-aware plan is rendered with assignments, risk notes, and projected metrics.
   Approve/commit the plan — the board switches to the committed plan version.
3. **Fault → exception** — The scripted battery fault fires. The fault is classified
   (`POST /telemetry/ingest` → fault classification), the affected task goes `HELD`,
   and the exception appears in the exception queue. Console: exception queue shows the
   open exception with its diagnosis and severity.
4. **Human intervention** — Pause, then resume the affected robot from the exception
   queue. Underlying API: `POST /interventions` (operator-attributed, audited).
5. **Agent proposal → human approval** — The `WEATHER_HOLD` watcher gives the device
   agent grounds to propose a bounded replan. The proposal review panel shows the
   diagnosis and proposed change; approve it there. Recovery executes **only** through
   the audited command path after your approval — no approval, no command.
6. **Audit trail** — Open the audit view. It must show, in order, with operator, action,
   timestamp, and plan version: the fault-recorded entry, the exception-opened entry,
   both interventions, the agent proposal (accepted), and the recovery command. Nothing
   may appear that did not happen; nothing that happened may be missing.
7. **Compliance surfacing** — Open a device detail view: production origin, FCC
   authorization status, firmware-update eligibility window, and cross-border
   data-flow profile are all visible (`GET /fleet/robots` compliance blocks).
8. **Benchmark view** — The seeded benchmark runs the harness created are visible in
   the benchmark view with their pass-bar verdicts (§3).

Headless variant (no console): the API integration tests re-drive steps 3–6 against an
in-process Fastify instance — `apps/api/test/api.integration.test.ts` is the CI-enforced
backstop for the chain, and D3 §6.3 is its specification.

## 3. Benchmark-bar re-run procedure

The spec's research claims are gated by three executable pass bars (concept doc §7):

| Bar                               | Threshold                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| On-time completion                | risk-aware planner ≥ **+15 pp** over the rule-based baseline |
| Interventions per 100 robot-hours | risk-aware planner ≥ **−20%** vs baseline                    |
| Hard-constraint violations        | **zero** for **both** schedulers in **every** scenario       |

### How to re-run

```sh
pnpm --filter @fleetos/scheduler bench:all                 # full set, writes bench/reports/
pnpm --filter @fleetos/scheduler bench:scenario -- --scenario=noise-ordinance   # one scenario
```

The CLI exits nonzero when any bar is missed; the JSON report and a markdown summary
land in `packages/scheduler/bench/reports/` (gitignored — artifacts, not source). CI
re-runs the full set in the **Scheduler benchmark** job of `.github/workflows/ci.yml`
and uploads the report as the `benchmark-report` artifact; a missed bar fails the job.
The scenario set is defined in `packages/scheduler/src/bench/scenarios.ts` (the D3 plan
named the preset files `seed-01`…`seed-04`; the shipped harness implements the same
axes as four code-versioned scenarios):

| Scenario            | Axes exercised                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `core-mowing`       | Mixed tariff, seeded BATTERY/MAINTENANCE_DUE/SENSOR_DEGRADED faults, one comms blackout (connectivity window) |
| `peak-tariff`       | Peak-price tariff pack — off-peak shifting and energy-cost axis                                               |
| `noise-ordinance`   | Noise-ordinance hard window — the zero-violations bar is asserted here per scheduler                          |
| `peak-tariff-shift` | Tariff-driven charging shift with a slack task set                                                            |

Both schedulers consume identical worlds through the identical runtime — only the
scheduling function differs — so any delta is attributable to the planner.

### Actuals to date

| Run                                  | On-time delta | Interventions | Hard-window violations | Verdict |
| ------------------------------------ | ------------- | ------------- | ---------------------- | ------- |
| Scheduler acceptance (PR #10 record) | +19.09 pp     | −25%          | 0                      | PASS    |
| Latest re-run on main (2026-11-01)   | +19.80 pp     | −20.00%       | 0                      | PASS    |

Values are exact functions of the code at the tested SHA: re-running on an unchanged
SHA reproduces the report bit-for-bit, and small drift between SHAs is expected as the
planner evolves. What must never drift below the bars is the verdict — the moment any
bar fails, the benchmark job is red and the release is blocked (§5).

## 4. Manual operator-console QA checklist

The console has no browser-unit framework in the MVP (D3 §2.9); its correctness is
pinned by the API integration tests it consumes plus this checklist, executed by hand
per the D3 visual-evidence rule: run against the tested head SHA, with screenshots and
a short recording captured for each checked item. Checkboxes are per release candidate.

- [ ] **QA-1 Fleet survey.** Fleet list shows all four simulators with capability and
      compliance badges; fleet map places robots on their sites. (M-1)
- [ ] **QA-2 Plan approval.** Load the seeded plan; assignments, risk notes, and
      projected metrics render; approving switches the board to the committed version
      and the board gates downstream views on that plan version. (M-2)
- [ ] **QA-3 Exception handling.** With the demo fault stream running: the battery
      fault opens an exception, the task shows `HELD`; pause and resume the robot from
      the queue; the audit view shows the full path with operator attribution. (M-3)
- [ ] **QA-4 Compliance panel.** Device detail shows production origin, FCC status,
      firmware-update window, and cross-border data-flow profile for every device. (M-4)
- [ ] **QA-5 Constraint packs.** With the tariff pack and noise window active, the
      schedule board shows shifted charging/tasks and visibly marks the hard window.
- [ ] **QA-6 Proposal review.** A device-agent proposal renders with its diagnosis;
      an out-of-envelope proposal is visibly rejected; approval is demanded before any
      recovery executes. (M-6)
- [ ] **QA-7 Benchmark view.** Seeded benchmark runs render with per-scenario metrics
      and the aggregate PASS verdict; a forced-fail run (bars missed) renders the FAIL
      verdict, not a blank panel.
- [ ] **QA-8 Degraded mode.** During the demo's comms blackout window, affected robots
      show degraded state and their stale telemetry is excluded from optimization (the
      plan does not "improve" on stale data mid-blackout).

QA-7/QA-8 are additions to the D3 §7 scripts (M-1–M-6), enabled by surfaces that shipped
after that plan was written. A failed manual item is a bug against this plan; the fix
task references the QA ID.

## 5. Release-candidate gate

A build is a **release candidate** (RC) only when **all** of the following hold on the
same head SHA, on a clean checkout of that SHA:

1. **Quality gate green.** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass with the
   full suite of §1 green (408 tests as of this document's SHA; more if tests were
   added — never fewer without a documented, approved reduction).
2. **Benchmark bars green.** The Scheduler benchmark job passes: every bar in §3 met,
   zero hard-window violations for both schedulers across all scenarios, report
   artifact attached to the run.
3. **Security gate green.** The gitleaks workflow (`.github/workflows/security.yml`)
   passes on the PR and the weekly full-history scan is clean at the RC SHA.
4. **Doc gates green.** The D2 and D3 doc-lint suites pass; this document's §1 counts
   and §3 scenario table match the tree (no drift between doc and code).
5. **Demo path walked.** The §2 walkthrough completed end to end, steps 1–8, on the RC
   SHA, with the fault → exception → intervention → approval → audit chain observed
   in order.
6. **Manual QA executed.** Every item in §4 checked against the RC SHA with visual
   evidence captured per the D3 rule; any failed item has an open bug task before the
   RC proceeds.
7. **Clean history state.** `main` is the RC source; no unrebased release branches; the
   working tree has no uncommitted changes.

The RC is tagged from `main` only after all seven hold. Anything that cannot be verified
on the SHA (e.g. the weekly scan has not run yet) waits — an RC never ships on "should
be fine".
