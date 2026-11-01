# @fleetos/core-schema

The FleetOS capability ontology — the versioned, vendor-neutral data contract
every other package builds against (spec D1). Owns the Zod schemas (runtime +
types) for:

| Type                             | Record                                                                                               | Schema                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Robot`                          | vendor-neutral registry record for one device (the spec's `RobotCapabilityRecord`)                   | `schemas/robot.schema.json`                                               |
| `RobotCapability`                | what a robot can do, physically and operationally                                                    | `schemas/robot-capability.schema.json`                                    |
| `ComplianceBlock`                | per-device FCC posture, firmware-update window, production origin, data residency                    | `schemas/compliance-block.schema.json`                                    |
| `DataFlowProfile`                | which OEM cloud the telemetry traverses, through which jurisdictions, with which minimized field set | `schemas/data-flow-profile.schema.json`                                   |
| `FleetTask`                      | one unit of schedulable work with its SLA window                                                     | `schemas/fleet-task.schema.json`                                          |
| `DispatchPlan` / `ScheduleEntry` | scheduling-core output and its per-robot assignments                                                 | `schemas/dispatch-plan.schema.json`, `schemas/schedule-entry.schema.json` |
| `TelemetrySample`                | one normalized telemetry sample                                                                      | `schemas/telemetry-sample.schema.json`                                    |
| `FaultEvent`                     | one event from the cross-vendor fault taxonomy                                                       | `schemas/fault-event.schema.json`                                         |
| `Intervention`                   | one recorded human touch (pause / resume / reassign / proposal decision)                             | `schemas/intervention.schema.json`                                        |
| `AuditEvent`                     | one append-only audit entry — the compliance evidence base                                           | `schemas/audit-event.schema.json`                                         |
| `ExternalConstraintPack`         | energy tariff / weather / site-rules / SLA constraints for the scheduler                             | `schemas/constraint-pack.schema.json`                                     |

## How the JSON Schema artifacts work

The **Zod schemas under `src/` are the single source of truth**. The checked-in
`schemas/*.schema.json` documents (JSON Schema draft 2020-12) are **generated**
from them:

```sh
pnpm --filter @fleetos/core-schema generate   # regenerate schemas/*.schema.json
```

Non-TS consumers import the documents via the `"./schemas/*"` export; TS
consumers import the Zod schemas and inferred types from the package root.
Two layers of tests keep both worlds honest:

- **Round-trip tests** (`tests/round-trip.test.ts`) — every schema parses its
  valid fixtures, survives JSON serialize → parse unchanged, and rejects its
  invalid samples.
- **Ajv parity tests** (`tests/parity.test.ts`) — every checked-in JSON Schema
  document, compiled with Ajv draft 2020-12 + `ajv-formats`, must accept/reject
  the **same samples** as its Zod counterpart, and must stay fresh (a Zod edit
  without regenerating fails the ordinary test run — CI never runs the
  generator itself).

## Zod-only invariants

Some rules cannot be expressed in JSON Schema (cross-field comparisons). They
are enforced by Zod refinements, marked `zodOnly: true` in
`tests/invalid-samples.ts`, and excluded from Ajv parity:

- `RobotCapability.chargeHours` — `[typical, worstCase]`, `typical <= worstCase`;
- `FleetTask.window` — `notBefore <= notAfter`, compared as instants.

SemVer discipline: `schemaVersion` is a SemVer string whose **major is pinned
to 1** by every schema. Minor/patch bumps are additive and backward
compatible; a major bump is a dedicated schema PR. Consumers gate records with
`isSchemaVersionCompatible`.

## Compliance semantics (FCC Covered List, 2026-07-28)

`ComplianceBlock` encodes the spec's data-compliance chapter as runtime data:

- `fccStatus: "authorized" | "waived-update-window" | "unauthorized"` —
  `"waived-update-window"` means the model was added to the Covered List by
  the 2026-07-28 action and keeps operating with firmware updates waived until
  the recorded expiry (`firmwareUpdateEligibleUntil`, ≥ 2029-01-01 for
  existing models);
- `productionOrigin` — place of production (ISO 3166-1 alpha-2), the axis the
  FCC rules are based on;
- `dataResidency` — the operator-chosen telemetry storage region and whether
  cross-border telemetry is allowed at all;
- `dataFlow` — the OEM cloud traversed, the jurisdictions transited, and the
  **minimum** telemetry field set the adapter consumes (minimization).

Enforcement of residency/minimization lives in the API; this package makes the
posture declarative and auditable. It states product posture, not legal
conclusions.

## Non-goals

No physical-robot control, no teleoperation surface (see `Intervention`'s
kinds — and the invalid sample that asserts `"teleoperate"` is rejected), no
billing, no marketplace. Learned prediction and LLM policies are Phase I
research seams, not schema concerns.
