import type { ExternalConstraintPack } from "@fleetos/core-schema";
import { ManualClock } from "@fleetos/adapters-sdk";
import { describe, expect, it } from "vitest";

import { createWorldModel } from "../src/index.js";
import { at, mowerRobot, scrubberRobot } from "./helpers.js";

function tariffPack(overrides: Partial<ExternalConstraintPack> = {}): ExternalConstraintPack {
  return {
    schemaVersion: "1.0.0",
    packId: "pack-tariff-test",
    source: "tariff",
    appliesTo: {}, // fleet-wide
    hard: [],
    soft: [
      {
        constraintId: "sc-demand-charge",
        description: "avoid aggregate charging at peak",
        weight: 0.7,
      },
    ],
    costTerms: [
      {
        curveId: "curve-test",
        currency: "USD",
        points: [{ at: "2026-11-02T00:00:00Z", pricePerKwh: 0.09 }],
      },
    ],
    provenance: { origin: "test tariff sheet", humanApproved: true, extractedBy: "human" },
    ...overrides,
  };
}

function noisePack(overrides: Partial<ExternalConstraintPack> = {}): ExternalConstraintPack {
  return tariffPack({
    packId: "pack-noise-test",
    source: "site-rules",
    appliesTo: { siteIds: ["site-a"] },
    soft: [],
    costTerms: [],
    hard: [
      {
        rule: "time-window",
        constraintId: "hc-noise-night",
        description: "municipal noise ordinance: no mowing 22:00-07:00",
        forbiddenWindows: [{ start: "22:00", end: "07:00" }],
      },
    ],
    provenance: { origin: "test ordinance", humanApproved: true, extractedBy: "human" },
    ...overrides,
  });
}

/**
 * Constraint packs reach the shadow through the PackSource seam — the
 * constructor takes `constraintPacks` (wire a constraints `PackLibrary`'s
 * `packsAt`); slices then carry exactly the packs in force for that robot.
 * Schema/semantic pack validation is the constraints package's contract
 * (its own suite covers it); the shadow consumes validated packs.
 */
describe("active constraint packs on shadow slices", () => {
  it("starts with no packs attached", () => {
    const model = createWorldModel({ robots: [mowerRobot()], clock: new ManualClock(at(0)) });
    expect(model.sliceFor("robot-mower-01")?.activeConstraintPacks).toEqual([]);
    expect(model.activePacks("robot-mower-01")).toEqual([]);
  });

  it("attaches a fleet-wide pack to every robot slice", () => {
    const packs = [tariffPack()];
    const model = createWorldModel({
      robots: [mowerRobot(), scrubberRobot()],
      clock: new ManualClock(at(0)),
      constraintPacks: () => packs,
    });
    expect(model.sliceFor("robot-mower-01")?.activeConstraintPacks.map((p) => p.packId)).toEqual([
      "pack-tariff-test",
    ]);
    expect(model.sliceFor("robot-scrubber-01")?.activeConstraintPacks.map((p) => p.packId)).toEqual(
      ["pack-tariff-test"],
    );
    // The accessor returns the same full pack objects as the slice field.
    expect(model.activePacks("robot-mower-01")).toEqual([tariffPack()]);
  });

  it("attaches a site-scoped pack only to robots assigned to that site", () => {
    const packs = [noisePack()];
    const model = createWorldModel({
      robots: [mowerRobot(), scrubberRobot()],
      clock: new ManualClock(at(0)),
      constraintPacks: () => packs,
    });
    model.assignSite("robot-mower-01", "site-a");
    expect(model.sliceFor("robot-mower-01")?.activeConstraintPacks.map((p) => p.packId)).toEqual([
      "pack-noise-test",
    ]);
    expect(model.sliceFor("robot-scrubber-01")?.activeConstraintPacks).toEqual([]);
  });

  it("matches robot-kind scopes without site assignments", () => {
    const packs = [noisePack({ appliesTo: { robotKinds: ["mower"] } })];
    const model = createWorldModel({
      robots: [mowerRobot(), scrubberRobot()],
      clock: new ManualClock(at(0)),
      constraintPacks: () => packs,
    });
    expect(model.sliceFor("robot-mower-01")?.activeConstraintPacks.map((p) => p.packId)).toEqual([
      "pack-noise-test",
    ]);
    expect(model.sliceFor("robot-scrubber-01")?.activeConstraintPacks).toEqual([]);
  });

  it("re-reads the source on every snapshot — replacing the pack set changes slices", () => {
    let packs: readonly ExternalConstraintPack[] = [tariffPack(), noisePack()];
    const model = createWorldModel({
      robots: [mowerRobot()],
      clock: new ManualClock(at(0)),
      constraintPacks: () => packs,
    });
    model.assignSite("robot-mower-01", "site-a");
    // Slices carry packs in the order the PackSource provides them (the
    // constraints PackLibrary is what sorts by packId — not packsForRobot).
    expect(model.sliceFor("robot-mower-01")?.activeConstraintPacks.map((p) => p.packId)).toEqual([
      "pack-tariff-test",
      "pack-noise-test",
    ]);
    packs = []; // the library rotated seasons / a pack was withdrawn
    expect(model.sliceFor("robot-mower-01")?.activeConstraintPacks).toEqual([]);
  });

  it("rejects unknown robots with typed errors", () => {
    const model = createWorldModel({
      robots: [mowerRobot()],
      clock: new ManualClock(at(0)),
      constraintPacks: () => [tariffPack()],
    });
    expect(() => model.activePacks("ghost-robot")).toThrowError(/not registered/);
    expect(() => model.assignSite("ghost-robot", "site-a")).toThrowError(/not registered/);
  });
});
