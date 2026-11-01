import type { EnergyCostCurve, ExternalConstraintPack, HardConstraint } from "@fleetos/core-schema";

/**
 * Semantic checks that Zod shape validation cannot express. A pack that
 * passes the schema but fails one of these is internally contradictory —
 * duplicate identities, an ambiguous price curve, a self-contradictory
 * window, or a pack that constrains nothing.
 */
export type PackIssueCode =
  "schema" | "duplicate-constraint-id" | "curve-not-ascending" | "ambiguous-window" | "empty-pack";

export interface PackIssue {
  readonly code: PackIssueCode;
  /** Dot-path of the offending field within the pack, e.g. "hard[0]". */
  readonly path: string;
  readonly message: string;
}

function duplicateIdIssues(ids: readonly string[], section: string): PackIssue[] {
  const seen = new Set<string>();
  const issues: PackIssue[] = [];
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      issues.push({
        code: "duplicate-constraint-id",
        path: `${section}[${index}]`,
        message: `constraint id "${id}" appears more than once in ${section}`,
      });
    }
    seen.add(id);
  }
  return issues;
}

function curveIssues(curve: EnergyCostCurve, index: number): PackIssue[] {
  let previous: number | undefined;
  for (const [pointIndex, point] of curve.points.entries()) {
    const at = Date.parse(point.at);
    if (previous !== undefined && !(at > previous)) {
      return [
        {
          code: "curve-not-ascending",
          path: `costTerms[${index}].points[${pointIndex}].at`,
          message:
            "energy price curve points must be strictly ascending in time — equal or out-of-order timestamps make the price at an instant ambiguous",
        },
      ];
    }
    previous = at;
  }
  return [];
}

function windowIssues(constraint: HardConstraint, index: number): PackIssue[] {
  if (constraint.rule !== "time-window") {
    return [];
  }
  const issues: PackIssue[] = [];
  for (const [windowIndex, window] of constraint.forbiddenWindows.entries()) {
    if (window.start === window.end) {
      issues.push({
        code: "ambiguous-window",
        path: `hard[${index}].forbiddenWindows[${windowIndex}]`,
        message: `window start equals end ("${window.start}") — neither empty nor a full day; split a 24h ban into two windows (e.g. 00:00→12:00 and 12:00→00:00)`,
      });
    }
  }
  return issues;
}

/** Validates one pack beyond its Zod shape. Empty return = semantically valid. */
export function validateConstraintPack(pack: ExternalConstraintPack): readonly PackIssue[] {
  const issues: PackIssue[] = [
    ...duplicateIdIssues(
      pack.hard.map((constraint) => constraint.constraintId),
      "hard",
    ),
    ...duplicateIdIssues(
      pack.soft.map((constraint) => constraint.constraintId),
      "soft",
    ),
    ...duplicateIdIssues(
      pack.costTerms.map((curve) => curve.curveId),
      "costTerms",
    ),
  ];
  for (const [index, curve] of pack.costTerms.entries()) {
    issues.push(...curveIssues(curve, index));
  }
  for (const [index, constraint] of pack.hard.entries()) {
    issues.push(...windowIssues(constraint, index));
  }
  if (pack.hard.length + pack.soft.length + pack.costTerms.length === 0) {
    issues.push({
      code: "empty-pack",
      path: "",
      message: "pack contains no hard constraints, soft constraints, or cost terms",
    });
  }
  return issues;
}
