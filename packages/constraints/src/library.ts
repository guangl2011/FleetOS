import type { ExternalConstraintPack } from "@fleetos/core-schema";
import { IsoDateTimeSchema } from "@fleetos/core-schema";

import { ConstraintError } from "./errors.js";

/**
 * One time-scoped version of a constraint pack. A pack id is a logical
 * entity (e.g. "tariff-bellevue"); versions give it effective-date windows
 * (summer vs winter tariff). Intervals are half-open: [effectiveFrom,
 * effectiveUntil) — adjacent seasons touch but never overlap, and the
 * boundary instant belongs to the later version.
 */
export interface VersionedConstraintPack {
  readonly pack: ExternalConstraintPack;
  /** RFC 3339 instant (with Z or explicit offset) from which this version applies, inclusive. */
  readonly effectiveFrom: string;
  /** RFC 3339 instant until which this version applies, exclusive; omitted = open-ended. */
  readonly effectiveUntil?: string;
}

export interface PackLibrary {
  /** Packs in force at an instant — at most one version per packId, sorted by packId. */
  packsAt(instant: string): readonly ExternalConstraintPack[];
  readonly versions: readonly VersionedConstraintPack[];
}

function parseInstant(instant: string, what: string): number {
  const parsed = IsoDateTimeSchema.safeParse(instant);
  if (!parsed.success) {
    throw new ConstraintError(
      "PACK_INSTANT_INVALID",
      `${what} is not an RFC 3339 timestamp: ${instant}`,
    );
  }
  return Date.parse(instant);
}

interface SortedVersion {
  readonly version: VersionedConstraintPack;
  readonly fromMs: number;
  /** Epoch ms, or undefined for open-ended. */
  readonly untilMs: number | undefined;
}

function checkedVersion(version: VersionedConstraintPack): SortedVersion {
  const fromMs = parseInstant(
    version.effectiveFrom,
    `effectiveFrom of pack ${version.pack.packId}`,
  );
  if (version.effectiveUntil === undefined) {
    return { version, fromMs, untilMs: undefined };
  }
  const untilMs = parseInstant(
    version.effectiveUntil,
    `effectiveUntil of pack ${version.pack.packId}`,
  );
  if (untilMs <= fromMs) {
    throw new ConstraintError(
      "PACK_VERSION_WINDOW_INVALID",
      `pack ${version.pack.packId}: effectiveUntil (${version.effectiveUntil}) must be after effectiveFrom (${version.effectiveFrom})`,
      { packId: version.pack.packId },
    );
  }
  return { version, fromMs, untilMs };
}

/**
 * Builds a versioned pack registry. Construction refuses an invalid
 * effective window and any two versions of one packId whose [from, until)
 * intervals overlap — which is exactly the guarantee that makes
 * `packsAt` deterministic: for every instant, at most one version of a
 * pack applies.
 */
export function createPackLibrary(versions: readonly VersionedConstraintPack[]): PackLibrary {
  const byPackId = new Map<string, SortedVersion[]>();
  for (const version of versions) {
    const checked = checkedVersion(version);
    const group = byPackId.get(version.pack.packId) ?? [];
    group.push(checked);
    byPackId.set(version.pack.packId, group);
  }
  for (const [packId, group] of byPackId) {
    const sorted = [...group].sort((a, b) => a.fromMs - b.fromMs);
    let previous: SortedVersion | undefined;
    for (const current of sorted) {
      if (
        previous !== undefined &&
        (previous.untilMs === undefined || current.fromMs < previous.untilMs)
      ) {
        throw new ConstraintError(
          "PACK_VERSIONS_OVERLAP",
          `pack ${packId}: versions effective ${previous.version.effectiveFrom}→${previous.version.effectiveUntil ?? "open"} and ${current.version.effectiveFrom}→${current.version.effectiveUntil ?? "open"} overlap, so selection at that instant would be ambiguous`,
          { packId },
        );
      }
      previous = current;
    }
  }

  return {
    packsAt(instant: string): readonly ExternalConstraintPack[] {
      const atMs = parseInstant(instant, "instant");
      const selected: ExternalConstraintPack[] = [];
      for (const group of byPackId.values()) {
        const match = group.find(
          (candidate) =>
            candidate.fromMs <= atMs &&
            (candidate.untilMs === undefined || atMs < candidate.untilMs),
        );
        if (match !== undefined) {
          selected.push(match.version.pack);
        }
      }
      return selected.sort((a, b) => (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0));
    },
    versions: [...versions],
  };
}
