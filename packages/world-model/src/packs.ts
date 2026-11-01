import type { ExternalConstraintPack, Robot } from "@fleetos/core-schema";
import { packAppliesTo } from "@fleetos/constraints";
import type { SelectorContext } from "@fleetos/constraints";

/**
 * Source of the constraint packs in force at an instant — wire a constraints
 * `PackLibrary`'s `packsAt` here. The source must be deterministic at a given
 * instant for the benchmark convention (same input → same shadow) to hold.
 */
export type PackSource = (instant: string) => readonly ExternalConstraintPack[];

/**
 * The packs of a set that apply to one robot at its site: selector matching
 * is the constraints package's semantics (`packAppliesTo`) — one source of
 * truth for what "applies to" means, never re-implemented here.
 */
export function packsForRobot(
  packs: readonly ExternalConstraintPack[],
  robot: Robot,
  siteId: string | null,
): readonly ExternalConstraintPack[] {
  return packs.filter((pack) => {
    // exactOptionalPropertyTypes: an unset dimension is omitted, never passed
    // as explicit undefined — a null site means "kind-only context".
    const context: SelectorContext =
      siteId === null ? { robotKind: robot.kind } : { siteId, robotKind: robot.kind };
    return packAppliesTo(pack, context);
  });
}
