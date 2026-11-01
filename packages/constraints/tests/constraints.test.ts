import { expect, describe, it } from "vitest";

import type { ExternalConstraintPack } from "@fleetos/core-schema";

import {
  ConstraintError,
  createPackLibrary,
  findInfeasibleScopes,
  ingestConstraintPacks,
  loadConstraintPacks,
  packAppliesTo,
  validateConstraintPack,
} from "../src/index.js";
import {
  hardTimeWindow,
  softWeight,
  tariffCurve,
  tariffPack,
  versioned,
  weatherCutoff,
} from "./builders.js";

/** Runs fn, returns the ConstraintError it threw; fails the test on any other outcome. */
function constraintError(fn: () => unknown): ConstraintError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConstraintError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw ConstraintError");
}

describe("constraint-pack validation", () => {
  it("accepts a valid versioned pack", () => {
    const pack = tariffPack({
      hard: [hardTimeWindow("hc-noise", [{ start: "22:00", end: "07:00" }])],
    });
    expect(validateConstraintPack(pack)).toEqual([]);
    expect(loadConstraintPacks([pack])).toBeDefined();
  });

  it("rejects an unknown source at the loader", () => {
    const error = constraintError(() =>
      loadConstraintPacks([tariffPack({ source: "gravity" as never })]),
    );
    expect(error.code).toBe("PACK_PARSE_FAILED");
  });

  it("rejects a malformed (non-ascending) cost curve", () => {
    const pack = tariffPack({
      costTerms: [
        tariffCurve("curve-bad", [
          { at: "2026-11-02T16:00:00-08:00", pricePerKwh: 0.28 },
          { at: "2026-11-02T08:00:00-08:00", pricePerKwh: 0.09 },
        ]),
      ],
    });
    const error = constraintError(() => ingestConstraintPacks([pack]));
    expect(error.code).toBe("PACK_SEMANTIC");
    expect(error.issues.map((issue) => issue.code)).toContain("curve-not-ascending");
  });

  it("rejects duplicate constraint ids within a section", () => {
    const pack = tariffPack({
      soft: [softWeight("sc-dupe", 0.4), softWeight("sc-dupe", 0.6)],
    });
    const error = constraintError(() => ingestConstraintPacks([pack]));
    expect(error.code).toBe("PACK_SEMANTIC");
    expect(error.issues.map((issue) => issue.code)).toContain("duplicate-constraint-id");
  });

  it("rejects an ambiguous (start equals end) forbidden window", () => {
    const pack = tariffPack({
      hard: [hardTimeWindow("hc-ambiguous", [{ start: "08:00", end: "08:00" }])],
    });
    const error = constraintError(() => ingestConstraintPacks([pack]));
    expect(error.code).toBe("PACK_SEMANTIC");
    expect(error.issues.map((issue) => issue.code)).toContain("ambiguous-window");
  });

  it("rejects a pack that constrains nothing", () => {
    const pack = tariffPack({ costTerms: [] });
    const error = constraintError(() => ingestConstraintPacks([pack]));
    expect(error.code).toBe("PACK_SEMANTIC");
    expect(error.issues.map((issue) => issue.code)).toContain("empty-pack");
  });
});

describe("hard-window conflict detection", () => {
  it("detects two overlapping-infeasible fleet-wide packs", () => {
    const night = tariffPack({
      packId: "pack-night",
      hard: [hardTimeWindow("hc-night", [{ start: "22:00", end: "07:00" }])],
    });
    const day = tariffPack({
      packId: "pack-day",
      hard: [hardTimeWindow("hc-day", [{ start: "07:00", end: "22:00" }])],
    });
    const error = constraintError(() => ingestConstraintPacks([night, day]));
    expect(error.code).toBe("PACK_SCOPE_INFEASIBLE");
    expect(error.findings).toHaveLength(1);
    expect(error.findings[0]?.reason).toBe("all-time-forbidden");
    expect(error.findings[0]?.packIds).toEqual(["pack-day", "pack-night"]);
  });

  it("accepts the same packs when a workable gap remains", () => {
    const night = tariffPack({
      packId: "pack-night",
      hard: [hardTimeWindow("hc-night", [{ start: "22:00", end: "07:00" }])],
    });
    const day = tariffPack({
      packId: "pack-day",
      hard: [hardTimeWindow("hc-day", [{ start: "08:00", end: "22:00" }])],
    });
    expect(findInfeasibleScopes([night, day])).toEqual([]);
    expect(() => ingestConstraintPacks([night, day])).not.toThrow();
  });

  it("does not let site-scoped packs contaminate other sites", () => {
    const siteA = tariffPack({
      packId: "pack-site-a",
      appliesTo: { siteIds: ["site-a"] },
      hard: [hardTimeWindow("hc-a", [{ start: "22:00", end: "07:00" }])],
    });
    const siteB = tariffPack({
      packId: "pack-site-b",
      appliesTo: { siteIds: ["site-b"] },
      hard: [hardTimeWindow("hc-b", [{ start: "07:00", end: "22:00" }])],
    });
    expect(findInfeasibleScopes([siteA, siteB])).toEqual([]);
  });

  it("detects infeasibility when a scoped pack combines with a fleet-wide one", () => {
    const scoped = tariffPack({
      packId: "pack-scoped",
      appliesTo: { siteIds: ["site-a"] },
      hard: [hardTimeWindow("hc-am", [{ start: "00:00", end: "12:00" }])],
    });
    const fleetWide = tariffPack({
      packId: "pack-fleet",
      hard: [hardTimeWindow("hc-pm", [{ start: "12:00", end: "00:00" }])],
    });
    const error = constraintError(() => ingestConstraintPacks([scoped, fleetWide]));
    expect(error.code).toBe("PACK_SCOPE_INFEASIBLE");
    expect(error.findings).toHaveLength(1);
    expect(error.findings[0]?.siteId).toBe("site-a");
    expect(error.findings[0]?.packIds).toEqual(["pack-fleet", "pack-scoped"]);
  });

  it("respects daysOfWeek when merging forbidden windows", () => {
    const always = tariffPack({
      packId: "pack-am",
      hard: [hardTimeWindow("hc-am", [{ start: "00:00", end: "12:00" }])],
    });
    const weekdayPm = tariffPack({
      packId: "pack-pm",
      hard: [
        hardTimeWindow("hc-pm", [{ start: "12:00", end: "00:00", daysOfWeek: [1, 2, 3, 4, 5] }]),
      ],
    });
    // Weekends keep 12:00–24:00 workable, so the week is never fully covered.
    expect(findInfeasibleScopes([always, weekdayPm])).toEqual([]);
  });

  it("detects a weather cutoff that forbids every condition", () => {
    const pack = tariffPack({
      packId: "pack-weather-all",
      source: "weather",
      hard: [weatherCutoff("hc-weather-all", ["clear", "light-rain", "wet-grass"])],
    });
    const error = constraintError(() => ingestConstraintPacks([pack]));
    expect(error.code).toBe("PACK_SCOPE_INFEASIBLE");
    expect(error.findings[0]?.reason).toBe("all-weather-forbidden");
  });

  it("reports the same findings regardless of pack input order", () => {
    const night = tariffPack({
      packId: "pack-night",
      hard: [hardTimeWindow("hc-night", [{ start: "22:00", end: "07:00" }])],
    });
    const day = tariffPack({
      packId: "pack-day",
      hard: [hardTimeWindow("hc-day", [{ start: "07:00", end: "22:00" }])],
    });
    expect(findInfeasibleScopes([night, day])).toEqual(findInfeasibleScopes([day, night]));
  });
});

describe("effective-date versioning", () => {
  const summer = tariffPack({
    packId: "pack-tariff-seasonal",
    costTerms: [tariffCurve("curve-summer", [{ at: "2026-06-01T00:00:00Z", pricePerKwh: 0.12 }])],
  });
  const winter = tariffPack({
    packId: "pack-tariff-seasonal",
    costTerms: [tariffCurve("curve-winter", [{ at: "2026-09-01T00:00:00Z", pricePerKwh: 0.18 }])],
  });

  it("switches versions deterministically at the half-open boundary", () => {
    const library = createPackLibrary([
      versioned(summer, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z"),
      versioned(winter, "2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ]);
    expect(library.packsAt("2026-07-15T12:00:00Z")).toEqual([summer]);
    // Boundary instant belongs to the later version: intervals are [from, until).
    expect(library.packsAt("2026-09-01T00:00:00Z")).toEqual([winter]);
    expect(library.packsAt("2026-05-01T00:00:00Z")).toEqual([]);
    // Deterministic: identical queries return identical results.
    expect(library.packsAt("2026-07-15T12:00:00Z")).toEqual(
      library.packsAt("2026-07-15T12:00:00Z"),
    );
  });

  it("is independent of construction order", () => {
    const a = createPackLibrary([
      versioned(summer, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z"),
      versioned(winter, "2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    ]);
    const b = createPackLibrary([
      versioned(winter, "2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"),
      versioned(summer, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z"),
    ]);
    expect(a.packsAt("2026-10-01T00:00:00Z")).toEqual(b.packsAt("2026-10-01T00:00:00Z"));
  });

  it("keeps an open-ended final version in force forever", () => {
    const library = createPackLibrary([versioned(winter, "2026-09-01T00:00:00Z")]);
    expect(library.packsAt("2031-01-01T00:00:00Z")).toEqual([winter]);
  });

  it("rejects overlapping versions of one pack id", () => {
    const error = constraintError(() =>
      createPackLibrary([
        versioned(summer, "2026-06-01T00:00:00Z", "2026-10-01T00:00:00Z"),
        versioned(winter, "2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"),
      ]),
    );
    expect(error.code).toBe("PACK_VERSIONS_OVERLAP");
    expect(error.packId).toBe("pack-tariff-seasonal");
  });

  it("rejects an effective window whose end is not after its start", () => {
    const error = constraintError(() =>
      createPackLibrary([versioned(summer, "2026-09-01T00:00:00Z", "2026-06-01T00:00:00Z")]),
    );
    expect(error.code).toBe("PACK_VERSION_WINDOW_INVALID");
  });

  it("rejects instants that are not RFC 3339 timestamps", () => {
    const library = createPackLibrary([versioned(winter, "2026-09-01T00:00:00Z")]);
    expect(constraintError(() => library.packsAt("not-a-time")).code).toBe("PACK_INSTANT_INVALID");
    expect(
      constraintError(() =>
        createPackLibrary([versioned(summer, "November 1, 2026", "2026-12-01T00:00:00Z")]),
      ).code,
    ).toBe("PACK_INSTANT_INVALID");
  });
});

describe("scheduler ingestion seam", () => {
  it("partitions hard constraints from soft constraints and cost terms", () => {
    const pack = tariffPack({
      packId: "pack-mixed",
      appliesTo: { siteIds: ["site-downtown-park"], robotKinds: ["mower"] },
      hard: [
        hardTimeWindow("hc-noise", [{ start: "22:00", end: "07:00" }]),
        weatherCutoff("hc-rain", ["light-rain"]),
      ],
      soft: [softWeight("sc-demand-charge", 0.7), softWeight("sc-sla-priority", 0.9)],
      costTerms: [tariffCurve("curve-pse")],
    });
    const ingested = ingestConstraintPacks([pack]);
    expect(ingested.hard.map((constraint) => constraint.rule)).toEqual([
      "time-window",
      "weather-cutoff",
    ]);
    expect(ingested.soft.map((constraint) => constraint.constraintId)).toEqual([
      "sc-demand-charge",
      "sc-sla-priority",
    ]);
    expect(ingested.costTerms.map((curve) => curve.curveId)).toEqual(["curve-pse"]);
  });

  it("refuses a human-drafted pack that is not approved", () => {
    const pack = tariffPack({
      provenance: { origin: "draft", humanApproved: false, extractedBy: "human" },
    });
    expect(constraintError(() => ingestConstraintPacks([pack])).code).toBe("PACK_UNAPPROVED");
  });

  it("refuses an ai-drafted pack before human approval", () => {
    const pack: ExternalConstraintPack = tariffPack({
      provenance: {
        origin: "ai extraction from contract doc",
        humanApproved: false,
        extractedBy: "ai-draft",
      },
    });
    const error = constraintError(() => ingestConstraintPacks([pack]));
    expect(error.code).toBe("PACK_UNAPPROVED");
    expect(error.packId).toBe("pack-tariff-test");
  });

  it("accepts an ai-drafted pack once a human has approved it", () => {
    const pack = tariffPack({
      provenance: {
        origin: "ai extraction from contract doc",
        humanApproved: true,
        extractedBy: "ai-draft",
      },
    });
    const ingested = ingestConstraintPacks([pack]);
    expect(ingested.costTerms).toHaveLength(1);
  });
});

describe("selector semantics", () => {
  const scoped = tariffPack({ appliesTo: { siteIds: ["site-a"], robotKinds: ["mower"] } });
  const fleetWide = tariffPack({ packId: "pack-fleet" });

  it("does not apply a site/kind-scoped pack outside its selector", () => {
    expect(packAppliesTo(scoped, { siteId: "site-a", robotKind: "mower" })).toBe(true);
    expect(packAppliesTo(scoped, { siteId: "site-b", robotKind: "mower" })).toBe(false);
    expect(packAppliesTo(scoped, { siteId: "site-a", robotKind: "scrubber" })).toBe(false);
    expect(packAppliesTo(scoped, {})).toBe(false);
  });

  it("applies a fleet-wide pack everywhere", () => {
    expect(packAppliesTo(fleetWide, { siteId: "site-a", robotKind: "mower" })).toBe(true);
    expect(packAppliesTo(fleetWide, { siteId: "site-b", robotKind: "scrubber" })).toBe(true);
    expect(packAppliesTo(fleetWide, {})).toBe(true);
  });
});
