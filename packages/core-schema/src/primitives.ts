import { z } from "zod";

import { SCHEMA_VERSION_PATTERN } from "./version.js";

/**
 * Primitive schemas and the pattern strings behind them. Patterns are kept
 * as exported strings because the generated JSON Schema documents embed the
 * same values; the parity tests fail when the two drift apart.
 */
export const ENTITY_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
export const FIELD_NAME_PATTERN = "^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$";
export const COUNTRY_CODE_PATTERN = "^[A-Z]{2}$";
export const CURRENCY_PATTERN = "^[A-Z]{3}$";
export const REGION_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";
export const TIME_OF_DAY_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
export const ISO_DATE_PATTERN = "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$";

/** Builds a string schema from one of the pattern constants above. */
export function patternSchema(pattern: string, message: string): z.ZodString {
  return z.string().regex(new RegExp(pattern), message);
}

export const SchemaVersionSchema = patternSchema(
  SCHEMA_VERSION_PATTERN,
  "schemaVersion must be SemVer compatible with major 1 (e.g. 1.0.0)",
);

/** Fleet-wide entity id: robot, task, site, plan, pack, operator, fault... */
export const EntityIdSchema = patternSchema(
  ENTITY_ID_PATTERN,
  "ids must be 1-128 chars of letters/digits/._:- with a leading alphanumeric",
);

/** Dotted camelCase telemetry field name, e.g. batteryPct or pose.lat. */
export const FieldNameSchema = patternSchema(
  FIELD_NAME_PATTERN,
  "telemetry field names use dotted camelCase (e.g. batteryPct, pose.lat)",
);

export const CountryCodeSchema = patternSchema(
  COUNTRY_CODE_PATTERN,
  "country codes must be ISO 3166-1 alpha-2 (e.g. US)",
);

export const CurrencyCodeSchema = patternSchema(
  CURRENCY_PATTERN,
  "currency must be an ISO 4217 code (e.g. USD)",
);

/** Operator-chosen data-residency region slug, e.g. us-west-2 or eu-central-1. */
export const RegionSchema = patternSchema(
  REGION_PATTERN,
  "regions are lowercase slugs (e.g. us-west-2)",
);

/** Local clock time, 24h HH:MM (noise ordinances, site access hours). */
export const TimeOfDaySchema = patternSchema(
  TIME_OF_DAY_PATTERN,
  'time of day must be 24h "HH:MM" (e.g. 22:00)',
);

/** ISO calendar date (YYYY-MM-DD), e.g. firmware-update waiver expiry. */
export const IsoDateSchema = patternSchema(
  ISO_DATE_PATTERN,
  "dates must be ISO calendar dates (YYYY-MM-DD)",
);

/** RFC 3339 timestamp with Z or an explicit UTC offset. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Anything bounded to [0, 1]: confidence, plan quality, constraint weights. */
export const UnitIntervalSchema = z.number().min(0).max(1);

/** Adapter-reported data quality / model confidence in [0, 1]. */
export const ConfidenceSchema = UnitIntervalSchema;

/** Percentage in [0, 100]: battery charge, task progress, reserve floors. */
export const PercentSchema = z.number().min(0).max(100);
