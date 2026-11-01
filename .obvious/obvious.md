# FleetOS — Agent Worker Guide

Vendor-independent Robot Fleet Operating System for Robot-as-a-Service (Circunar Inc.).
Vendor-neutral operations layer: capability ontology → adapter SDK → world model → risk-aware
scheduler → operator console. Simulator-first: everything runs against in-process simulators;
no physical robot is driven anywhere in this repo. Source of truth for product scope:
the approved spec "FleetOS MVP and NSF Phase I — Product Spec".

> Status: scaffold + first domain packages (`core-schema`, `constraints`). Remaining domain packages and apps land in follow-up PRs — the planned layout below
> is the contract new work must fit into.

## Repo map

```
.
├── apps/                 # Deployable applications (planned — follow-up PRs)
│   ├── api/              #   Fastify API, SQLite persistence
│   └── console/          #   React (Vite) operator console
├── packages/             # Shared libraries (core-schema + constraints landed, rest in follow-up PRs)
│   ├── core-schema/      #   Capability/telemetry/fault schemas — v1, additive-only evolution (landed)
│   ├── adapters-sdk/     #   FleetAdapter contract + OEM mower/scrubber simulators
│   ├── world-model/      #   Digital shadow, per-robot confidence, prediction seam
│   ├── constraints/      #   Constraint packs: validation, effective-date versioning, ingestion seam (landed)
│   ├── device-agents/    #   Per-device deterministic policy agents (bounded autonomy)
│   ├── scheduler/        #   Risk-aware planner + rule-based baseline + benchmark harness
│   └── fleet-health/     #   Fault classification, exception queue, audit trail, degraded mode
├── tests/                # Root-level smoke suites (smoke.test.ts exists today)
├── docs/                 # plan/, design/, testing/ — product plan, design doc, testing plan (planned)
├── .github/workflows/    # ci.yml (quality gate), security.yml (gitleaks)
├── pnpm-workspace.yaml   # workspaces: packages/*, apps/*; allowBuilds: esbuild
├── tsconfig.base.json    # strict TS 5.9, NodeNext, ES2022
├── eslint.config.js      # ESLint 9 flat config (typescript-eslint recommended)
├── vitest.config.ts      # includes tests/**, packages/**, apps/** test files
└── .prettierrc.json      # double quotes, semicolons, trailing commas, width 100
```

### Package boundaries (hard rules)

- **Core never imports vendor code.** `FleetAdapter` implementations live with their simulators;
  scheduler/world-model/consumers read capability records, never vendor specifics.
- Workspaces resolve only via `packages/*` and `apps/*` under pnpm; cross-package imports go
  through package names, not relative paths out of a package root.
- `core-schema` is the single source of shared types — versioned, additive-only evolution.
- Device agents **propose**, never act: recovery commands require human approval and land in the
  audit trail. No remote-driving/teleoperation surface, ever.
- Local safety authority stays with the robot/simulator; the dispatch surface is
  pause/resume/reassign only.

## Commands

Node >= 20 (see `.nvmrc`); pnpm is pinned via `packageManager` — `corepack enable` first.

| Command                             | What it does                                             |
| ----------------------------------- | -------------------------------------------------------- |
| `pnpm install`                      | Install all workspace deps (`--frozen-lockfile` in CI)   |
| `pnpm lint`                         | ESLint over the repo (flat config)                       |
| `pnpm typecheck`                    | `pnpm -r --if-present typecheck` + root `tsc --noEmit`   |
| `pnpm test`                         | Vitest run (root suites + any workspace tests)           |
| `pnpm build`                        | `pnpm -r --if-present build` (no-op until packages land) |
| `pnpm format` / `pnpm format:check` | Prettier write / check                                   |

All of these must pass before any push; CI runs `lint` → `typecheck` → `test` on every PR and
push to `main`, plus a weekly full-history gitleaks scan (and on every PR). `security.yml` is the
secret-scan gate — a leaked-looking string blocks merge.

New workspace packages must expose `test` (Vitest) and, where applicable, `build` and `typecheck`
scripts — root scripts fan out with `pnpm -r --if-present`, so a package that forgets them is
silently untested.

## Conventions

- **Branches:** `task/<short-slug>-<task-id>` for autobuild task work; `chore/…`, `feat/…`,
  `fix/…` otherwise. Never push to `main`.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).
  All commits authored by `Obvious <obvious@obvious.ai>` with
  `Co-authored-by: Richard Lu <guangl2011@gmail.com>` trailer.
- **PRs:** draft first, promote when implementation is done; squash-merge via `gh pr merge --squash`.
- **Style:** TypeScript strict, ESM only (`"type": "module"`), `type` imports enforced
  (`consistent-type-imports`), unused vars prefixed `_`. Prettier config is authoritative for
  formatting (double quotes, width 100).
- **Determinism:** simulator/benchmark scenarios are seeded; a test that depends on wall-clock or
  randomness without a seed is a bug.

## Where things live (spec deliverables)

| Deliverable                                                                | Location                                      |
| -------------------------------------------------------------------------- | --------------------------------------------- |
| Capability schema, compliance block                                        | `packages/core-schema`                        |
| Adapter contract + 4 simulators (Greenworks, Navimow, Husqvarna, scrubber) | `packages/adapters-sdk`                       |
| Digital shadow + confidence                                                | `packages/world-model`                        |
| Constraint packs (energy/weather/site/SLA)                                 | `packages/constraints`                        |
| Per-device agents (deterministic MVP policy)                               | `packages/device-agents`                      |
| Risk-aware planner, baseline, benchmark                                    | `packages/scheduler`                          |
| Faults, exceptions, audit trail                                            | `packages/fleet-health`                       |
| Fastify API (residency/minimization)                                       | `apps/api`                                    |
| Operator console                                                           | `apps/console`                                |
| Product plan / design doc / testing plan                                   | `docs/plan/`, `docs/design/`, `docs/testing/` |
| NSF pitch + Phase I drafts                                                 | project artifacts (not in repo)               |

## Non-goals (do not build these)

Physical robot control, teleoperation video, safety-certified remote driving, billing/RaaS
contracting, mobile apps, marketplace. Learned world-model prediction and LLM-based
agent/constraint policies are Phase I research seams — ship the typed seam, not the AI.
