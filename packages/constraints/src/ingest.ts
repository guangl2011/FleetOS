import type {
  EnergyCostCurve,
  ExternalConstraintPack,
  HardConstraint,
  WeightedConstraint,
} from "@fleetos/core-schema";
import { ExternalConstraintPackSchema } from "@fleetos/core-schema";

import { findInfeasibleScopes } from "./coverage.js";
import { ConstraintError } from "./errors.js";
import type { PackIssue } from "./validate.js";
import { validateConstraintPack } from "./validate.js";

/**
 * What the scheduler's constrained optimum consumes: the hard constraints it
 * may never violate, and the soft constraints and cost curves that price the
 * same objective. Every pack in here is shape-valid, semantically valid,
 * jointly feasible, and human-approved.
 */
export interface IngestedConstraints {
  readonly hard: readonly HardConstraint[];
  readonly soft: readonly WeightedConstraint[];
  readonly costTerms: readonly EnergyCostCurve[];
}

/**
 * The scheduler-ingestion seam. Refuses:
 * - semantically invalid packs (duplicate ids, ambiguous curves/windows, empty packs);
 * - unapproved packs — `humanApproved: false` never reaches the optimizer,
 *   which is the gate that keeps AI-drafted packs out until a human signs
 *   off (the Phase I AI-constraint-extraction seam, spec D4 claim 5);
 * - pack sets whose hard constraints jointly leave a scope unschedulable.
 */
export function ingestConstraintPacks(
  packs: readonly ExternalConstraintPack[],
): IngestedConstraints {
  for (const pack of packs) {
    const issues = validateConstraintPack(pack);
    if (issues.length > 0) {
      throw new ConstraintError("PACK_SEMANTIC", `pack ${pack.packId} failed semantic validation`, {
        packId: pack.packId,
        issues,
      });
    }
    if (!pack.provenance.humanApproved) {
      throw new ConstraintError(
        "PACK_UNAPPROVED",
        `pack ${pack.packId} is not human-approved (extractedBy: ${pack.provenance.extractedBy ?? "human"}) — nothing reaches the optimizer unapproved`,
        { packId: pack.packId },
      );
    }
  }
  const findings = findInfeasibleScopes(packs);
  if (findings.length > 0) {
    throw new ConstraintError(
      "PACK_SCOPE_INFEASIBLE",
      "combined hard constraints leave no schedulable time or weather for some scope",
      { findings },
    );
  }
  return {
    hard: packs.flatMap((pack) => pack.hard),
    soft: packs.flatMap((pack) => pack.soft),
    costTerms: packs.flatMap((pack) => pack.costTerms),
  };
}

function parseIssues(
  failure: { issues: readonly { path: PropertyKey[]; message: string }[] },
  index: number,
): PackIssue[] {
  return failure.issues.map((issue) => ({
    code: "schema" as const,
    path: `packs[${index}]${issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : ""}`,
    message: issue.message,
  }));
}

/**
 * The loader for untyped pack sources — console uploads, API bodies, files.
 * Parses each entry against the core-schema pack schema (unknown sources,
 * missing fields, bad shapes fail here), then applies the same seam rules
 * as `ingestConstraintPacks`.
 */
export function loadConstraintPacks(rawPacks: readonly unknown[]): IngestedConstraints {
  const parsed = rawPacks.map((raw, index) => {
    const result = ExternalConstraintPackSchema.safeParse(raw);
    if (!result.success) {
      throw new ConstraintError(
        "PACK_PARSE_FAILED",
        `pack at index ${index} does not match ExternalConstraintPack schema v1`,
        {
          issues: parseIssues(result.error, index),
        },
      );
    }
    return result.data;
  });
  return ingestConstraintPacks(parsed);
}
