# FleetOS

A vendor-independent **Robot Fleet Operating System** for Robot-as-a-Service, by Circunar Inc.
FleetOS normalizes heterogeneous service-robot fleets (mowing first, other categories next) behind
one capability ontology, schedules work under uncertainty, and keeps humans in supervision of every
recovery action.

> Status: scaffold. Domain packages and apps land in follow-up PRs per the approved product spec.

## Monorepo layout

TypeScript ESM pnpm monorepo, Node >= 20.

```
.
├── apps/            # Deployable applications (land in follow-up PRs)
│   ├── api/         #   Fastify API with SQLite persistence (planned)
│   └── console/     #   React (Vite) operator console (planned)
├── packages/        # Shared libraries (land in follow-up PRs)
│   ├── core-schema/ #   Capability/telemetry/fault schemas (planned)
│   ├── adapters-sdk/#   Adapter contract + OEM simulators (planned)
│   ├── world-model/ #   Digital shadow + confidence estimation (planned)
│   ├── constraints/ #   External constraint packs (planned)
│   ├── device-agents/#  Per-device bounded-autonomy agents (planned)
│   ├── scheduler/   #   Risk-aware planner + baseline + benchmark (planned)
│   └── fleet-health/#   Fault classification, audit trail, degraded mode (planned)
├── tests/           # Root-level smoke suites
└── .github/workflows/  # CI: lint + typecheck + test on PRs and pushes to main
```

## Getting started

```bash
corepack enable        # provides pnpm (pinned via packageManager)
pnpm install
pnpm lint              # ESLint (flat config)
pnpm typecheck         # tsc --noEmit across the workspace
pnpm test              # Vitest
pnpm build             # build all workspaces (no-op until packages land)
```

## Conventions

- TypeScript strict mode, ESM only (`"type": "module"`).
- Package boundaries are enforced by workspace layout — core never imports vendor code.
- Every workspace package exposes `test` (Vitest) and, where applicable, `build` and `typecheck`
  scripts; root scripts fan out with `pnpm -r --if-present`.
- CI must stay green: lint + typecheck + tests run on every PR and on pushes to `main`.

## License

Proprietary — © Circunar Inc. All rights reserved.
