/**
 * Schema versioning rules (SemVer discipline, spec art_s9VfpgZW).
 *
 * The major version gates compatibility: a major bump is the signal for a
 * breaking contract change, and schema changes land only in dedicated PRs.
 * Consumers reject records whose major is not the supported one, so
 * minor/patch additions flow through without code changes.
 */

/** Current version of the FleetOS capability-ontology contract published by this package. */
export const SCHEMA_VERSION = "1.0.0";

/** The only major version readers of this package accept. */
export const SUPPORTED_SCHEMA_MAJOR = 1;

/**
 * JSON-Schema-ready pattern for a compatible schemaVersion: SemVer X.Y.Z with
 * no leading zeros and the major pinned to 1. Kept as a string so the Zod
 * schema and the generated JSON Schema files share one source (the parity
 * tests enforce the sync).
 */
export const SCHEMA_VERSION_PATTERN = "^1\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$";

/** Generic SemVer pattern (any major, no leading zeros) used for parsing. */
const SEMVER_PATTERN = "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$";

export interface SchemaVersionParts {
  major: number;
  minor: number;
  patch: number;
}

/** Parses a SemVer X.Y.Z string; returns null when it is not one. */
export function parseSchemaVersion(version: string): SchemaVersionParts | null {
  const match = new RegExp(SEMVER_PATTERN).exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** True when a record's schemaVersion can be read by consumers of this contract. */
export function isSchemaVersionCompatible(version: string): boolean {
  const parts = parseSchemaVersion(version);
  return parts !== null && parts.major === SUPPORTED_SCHEMA_MAJOR;
}
