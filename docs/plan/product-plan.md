# FleetOS — Product Development Plan

**Circunar Inc. · Vendor-independent Robot Fleet Operating System for Robot-as-a-Service**

**Status:** plan of record for the FleetOS MVP and NSF SBIR Phase I preparation. Draft for improvement — every performance target, partner, and budget figure below is proposed and must be validated before any submission.

**Summary.** FleetOS is a vendor-neutral operations layer for mixed-brand service-robot fleets: one capability ontology, one scheduling core, one operator console — across every OEM on the fleet. The first market is commercial mowing, where operators routinely run 10–200 robots from multiple OEMs whose closed dashboards cannot schedule across brands. The MVP proves the concept in simulation against a rule-based baseline; the NSF SBIR Phase I documents package the research claims. This document covers market framing, competitive position, the phased integration roadmap, the M1–M12 milestone plan, and the risk register. The system design lives in [docs/design/fleetos-design.md](../design/fleetos-design.md).

Sources are named inline. Web-page citations for market facts live in the Research stage completion note on the project's task tree; this document names what each source showed. Nothing here is from unverified memory of "typical" markets.

---

## 1. Market framing: the vendor-neutral operations layer

A managed RaaS operator running commercial mowers today buys each OEM's own fleet software. That software sees only its own robots. The operator's real problems sit between the brands: balancing work and batteries across the whole site, reconciling weather windows and noise ordinances with customer SLAs, and paying technicians to triage exceptions that a cross-fleet scheduler would have prevented. The concept document states it directly: "Commercial RaaS fleets mix vendors, firmware, battery constraints, task geographies and safety policies. Today's vendor-specific dashboards cannot reliably schedule cross-brand robots, reason about failure risk or orchestrate field service at fleet scale" (`02_Circunar_RaaS_Fleet_OS.docx` §2).

FleetOS is therefore positioned as an operations layer, not another dashboard: it ingests every fleet through one adapter contract, normalizes capabilities and telemetry into one world model, schedules under uncertainty against external constraints, and gives a human operator one console with one exception queue and one audit trail. OEM dashboards keep doing what they do well — device onboarding and vendor-specific diagnostics — under a fleet-wide operations layer.

**Mowing first.** Commercial mowing is the first validation market (`02_Circunar_RaaS_Fleet_OS.docx` §1). The operational reality of commercial mowing is unusually well-suited to fleet software: weather cutoffs, battery and charging coordination, multi-mower balancing on one property, no-go zones, maintenance intervals, and API access — the feature set market research identified for commercial mowing (Research stage record). The first physical integration batch is founder-confirmed (2026-11-01, thread record): **Greenworks, 九号/Segway Navimow, and Husqvarna** mowing robots, with Husqvarna's Open API for commercial/professional mowers already documented as open to third-party fleet platforms.

**Scrubbing next.** Robotic cleaning for retail, hospitality, and healthcare is the second target segment. Managed robotic-cleaning RaaS operators (researched example: upclean.ai, Research stage record) show the same pain profile — mixed robots, SLA accountability, exception labor — with no fleet-software product addressing the cross-vendor layer. The MVP proves cross-category readiness with a scrubber simulator behind the same adapter contract; no cleaning deployment enters MVP scope.

**Why the buyer pays.** The economics that matter to a RaaS operator are interventions and SLA credits. The concept document's success bars make both measurable: ≥15% on-time task completion over a rule-based baseline and ≥20% fewer operator interventions per 100 robot-hours in controlled trials (`02_Circunar_RaaS_Fleet_OS.docx` §7). FleetOS reports both numbers per benchmark scenario — the sales conversation starts from the operator's own labor line.

**A regulatory tailwind.** On 2026-07-28, the FCC added foreign-produced "advanced robotic devices" to its Covered List (FCC 26-50; analyzed by AnJie Broad, Research stage record). Place-of-production rules mean a mixed fleet can carry robots with different authorization status, data-flow exposure, and firmware-update windows. FleetOS treats compliance as a runtime product feature — per-device compliance records, data residency, cross-border flow surfacing — rather than paperwork (see the design doc's Data Compliance chapter). For operators mixing Chinese-made and other OEM robots, this is a purchasing argument no OEM-locked suite can make.

## 2. Competitive positioning

Two incumbent categories cover the edges of the problem; neither covers the middle. The Research stage record's findings:

| Category                           | Examples                                               | What they do                                                                                                                     | What they miss                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Generic RobOps platforms           | Auterion Suite, Formant, InOrbit, Freedom Robotics     | Observability-heavy: telemetry aggregation, video, device management across vendors                                              | Thin domain scheduling — no mowing-domain jobs, no battery/weather/SLA optimization, no external-constraint model                       |
| OEM fleet suites                   | Segway NavimowFleet, Husqvarna fleet tools             | Deep single-vendor integration; cloud APIs exist (NavimowFleet claims API integration; Husqvarna Open API for commercial mowers) | One brand only. Scheduling, health, and compliance stop at the logo. Vendor-isolated dispatch is exactly the baseline FleetOS must beat |
| Point solutions / in-house scripts | Operator-built spreadsheets, cron jobs, per-site rules | Cheap, tailored                                                                                                                  | No fleet state model, no fault taxonomy, no audit trail, brittle under weather and fault load                                           |

**The defensible seam** is the middle: cross-brand _scheduling and operations under uncertainty_, with domain depth mowing-first. Observability platforms could move toward it, but they lack the mowing-domain cost model and the OEM adapter work; OEM suites cannot build it without contradicting their single-vendor business. FleetOS's adapter SDK treats OEM cloud APIs (the Navimow and Husqvarna precedent) as legitimate integration targets — the same seam the OEMs themselves publish.

## 3. Customers and segments

The concept document names the initial segment: commercial landscaping companies and autonomous mower distributors deploying 10–200 robots (`02_Circunar_RaaS_Fleet_OS.docx` §8). At that size, an operator has fleet economics to optimize but no software team to build a fleet layer — the size where buying beats building.

Later segments follow the same operator shape: cleaning, then security and inspection fleets (`02_Circunar_RaaS_Fleet_OS.docx` §8). The MVP's scrubber simulator exists to prove the ontology generalizes past mowing before a single cleaning robot is integrated. Segment expansion is a post-MVP, founder-sequenced decision.

## 4. Phased integration roadmap

Integration order is founder-confirmed (2026-11-01, thread record) and locked in the approved spec:

| Phase                                            | Robots                                                                  | Vehicle                                                                                                         | Milestone bar                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **MVP (simulators)**                             | Greenworks mower, 九号/Navimow mower, Husqvarna mower, generic scrubber | Four in-process simulators modeling the OEM APIs, seeded fault profiles, identical adapter contract tests in CI | All four adapters pass one contract suite; scheduler beats baseline by the §7 bars                               |
| **Phase I pilot (physical, if partners permit)** | ≥2 of the first-batch mowers                                            | Real OEM cloud APIs through the same adapter contracts validated in simulation                                  | ≥3 robot interfaces represented (docx §7); controlled commercial mowing pilot with human-supervised intervention |
| **Expansion (gradual)**                          | Other mower OEMs first, then next categories (scrubbing next)           | New adapters only — no core changes, by contract-test discipline                                                | Category N inherits the same benchmark and audit infrastructure                                                  |

The simulator-first decision is a scope decision, not a hedge: the MVP's acceptance criteria are the concept document's success criteria made executable in simulation, reproducible in CI on every pull request. Physical-device integration stays a post-MVP path — "at least 2 using physical devices if partners permit" (`02_Circunar_RaaS_Fleet_OS.docx` §7) — and robot-local safety stays authoritative whenever it arrives (docx §10; MVP never models remote driving).

## 5. Milestone plan (M1–M12)

Aligned to the Phase I work plan, `02_Circunar_RaaS_Fleet_OS.docx` §6. The MVP codebase (deliverable D1) lands inside M1–M6; the Phase I research agenda continues on top of it.

| Period      | Concept-doc work package                                                                    | FleetOS execution                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1–M3**   | User discovery, baseline fleet workflows, system architecture, test datasets and simulation | Operator discovery with target customers; baseline workflow documentation; capability schema v1 and adapter contract frozen; simulator test datasets and seeded fault scenarios defined; monorepo + CI live                                                                         |
| **M4–M6**   | Adapters, event model, operator dashboard and initial scheduling algorithms                 | Four simulator adapters shipped; normalized telemetry/fault event model; risk-aware scheduler + rule-based baseline + benchmark harness; operator console (fleet, schedule board, exception queue); MVP acceptance criteria met                                                     |
| **M7–M9**   | Fault prediction, intervention workflows, resilience and cyber-security testing             | World-model confidence calibration measured; device agents (deterministic policy, bounded autonomy); constraint packs (tariff, weather, site, SLA) in the scheduler with the energy-cost axis; degraded-mode and telemetry-loss scenarios tested; data-compliance features complete |
| **M10–M12** | Controlled pilot, economic sensitivity analysis, Phase II plan                              | Controlled mowing pilot (physical, if partners permit) or full simulation pilot; economic sensitivity analysis — interventions/100 robot-hours, on-time completion, energy cost; Phase II plan and commercialization follow-on                                                      |

MVP verification maps to these packages: D1 acceptance criteria are tracked per workstream in the approved spec's Verification section.

## 6. Business model

Per the concept document (§8): a **per-active-robot monthly platform fee**, plus onboarding, premium fleet analytics, and service-partner integrations. The energy-cost dimension strengthens the pitch: constraint packs shift charging and energy-heavy work off-peak, and the benchmark reports the dollar delta — analytics customers can price against their own tariff.

## 7. Risk register

Risks from the concept document (§10) plus product-level risks surfaced in the approved spec. Likelihood/impact are planning judgments, not measurements.

| #   | Risk                                                                                       | Source                | L / I | Mitigation                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------ | --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OEM integration access denied or delayed for physical devices                              | docx §10              | M / H | Simulator-first MVP removes the dependency; opt-in SDK paths, documented protocols (Husqvarna Open API already published), simulation fallback for any OEM that closes access |
| 2   | Insufficient field data for training/validating risk models                                | docx §10              | M / M | Synthetic seeded scenarios carry the benchmark; limited pilot data layered on; evaluation methods pre-registered                                                              |
| 3   | Liability and remote-control exposure                                                      | docx §10              | L / H | No teleoperation anywhere in scope; local safety controller stays authoritative; remote surface limited to pause/resume/reassign; every command audited                       |
| 4   | Observability platforms (Formant/InOrbit) expand into domain scheduling                    | Market analysis       | M / M | Domain depth is the moat: mowing cost model, constraint packs, OEM adapters; speed and the measured benchmark are the counter                                                 |
| 5   | OEM suites open up (Husqvarna-style) but stay single-vendor                                | Market analysis       | L / L | Cross-vendor layer remains the differentiator; openness of an OEM _increases_ FleetOS adapter coverage                                                                        |
| 6   | FCC/regulatory shifts change compliance requirements                                       | Spec (FCC 2026-07-28) | M / M | Compliance modeled as versioned per-device records and configurable residency — rules changes become data updates, not architecture changes                                   |
| 7   | Scheduling advantage fails to clear the docx bars (≥15% on-time, ≥20% fewer interventions) | docx §7               | M / H | The benchmark is the early-warning system: it runs in CI from M4, so the gap is visible months before submission, and the objective terms are tunable knobs                   |
| 8   | NSF applicant-entity and eligibility questions                                             | Spec open question    | M / M | Entity flagged "verify" in both NSF documents (docx names Circunar Inc.); pre-submission checklist tracks registrations and ownership verification                            |
| 9   | Scope creep into billing, mobile apps, marketplace                                         | Spec non-goals        | M / L | Non-goal guardrail in the approved spec; expansion only by founder decision                                                                                                   |

## 8. Product plan → design

The design document translates this plan into contracts: the capability ontology and adapter SDK (customers 1 and 3 depend on it), the world model and scheduler (claims in section 1 and 2), constraint packs (energy value in section 6), device agents (the intervention-reduction lever in section 1), and data compliance (the regulatory argument in section 1). Cross-references are bidirectional — [docs/design/fleetos-design.md](../design/fleetos-design.md) is the technical source of truth for everything above that says "by design."

---

_Sources: `02_Circunar_RaaS_Fleet_OS.docx` (fl_vsuFP4sL, full text extracted 2026-11-01) — sections cited inline; FleetOS Product Spec `art_s9VfpgZW` (approved) — locked decisions, evidence list, Verification criteria; market and regulatory facts — Research stage completion note on the project task tree (web citations recorded there), including the FCC 26-50 Covered List action analyzed by AnJie Broad (2026-07-28) and competitor product scans (Auterion, Formant, InOrbit, Freedom Robotics, NavimowFleet, Husqvarna, upclean.ai)._
