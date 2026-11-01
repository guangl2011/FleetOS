import { z } from "zod";

import { RobotKindSchema, WeatherConditionSchema } from "./capability.js";
import {
  CurrencyCodeSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  SchemaVersionSchema,
  TimeOfDaySchema,
  UnitIntervalSchema,
} from "./primitives.js";

/** What family of external rule a constraint pack encodes (spec constraints chapter). */
export const CONSTRAINT_SOURCES = ["tariff", "weather", "site-rules", "sla", "regulation"] as const;
export type ConstraintSource = (typeof CONSTRAINT_SOURCES)[number];
export const ConstraintSourceSchema = z.enum(CONSTRAINT_SOURCES);

/**
 * Scope of a constraint pack: sites and/or robot classes. An empty selector
 * (neither field set) applies the pack fleet-wide — a meaningful, explicit
 * choice, so no cross-field refine here.
 */
export const SiteSelectorSchema = z.strictObject({
  siteIds: z.array(EntityIdSchema).min(1).optional(),
  robotKinds: z.array(RobotKindSchema).min(1).optional(),
});

export type SiteSelector = z.infer<typeof SiteSelectorSchema>;

/** One local-clock window; may wrap midnight (e.g. 22:00 → 07:00 noise rule). */
export const DailyWindowSchema = z.strictObject({
  start: TimeOfDaySchema,
  end: TimeOfDaySchema,
  /** Weekday numbers 0=Sunday … 6=Saturday; omitted = every day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
});

export type DailyWindow = z.infer<typeof DailyWindowSchema>;

/**
 * Hard constraints the scheduler may never violate, discriminated by `rule`:
 * - "time-window" — site access hours, noise ordinances: work is forbidden
 *   inside the listed local-clock windows;
 * - "weather-cutoff" — weather states that stop the affected work outright.
 */
export const HardConstraintSchema = z.discriminatedUnion("rule", [
  z.strictObject({
    rule: z.literal("time-window"),
    constraintId: EntityIdSchema,
    description: z.string().min(1).max(500),
    forbiddenWindows: z.array(DailyWindowSchema).min(1),
  }),
  z.strictObject({
    rule: z.literal("weather-cutoff"),
    constraintId: EntityIdSchema,
    description: z.string().min(1).max(500),
    forbiddenConditions: z.array(WeatherConditionSchema).min(1),
  }),
]);

export type HardConstraint = z.infer<typeof HardConstraintSchema>;

/** Soft constraints: scored trade-offs inside the same objective, not hard limits. */
export const WeightedConstraintSchema = z.strictObject({
  constraintId: EntityIdSchema,
  description: z.string().min(1).max(500),
  /** Relative weight in [0, 1] (e.g. demand-charge aversion, SLA priority). */
  weight: UnitIntervalSchema,
});

export type WeightedConstraint = z.infer<typeof WeightedConstraintSchema>;

export const EnergyPricePointSchema = z.strictObject({
  at: IsoDateTimeSchema,
  pricePerKwh: z.number().min(0),
});

/**
 * $/kWh price curve for the benchmark's energy-cost axis: shifting charging
 * and energy-heavy work off-peak is measured, not asserted (spec D1).
 */
export const EnergyCostCurveSchema = z.strictObject({
  curveId: EntityIdSchema,
  currency: CurrencyCodeSchema,
  points: z.array(EnergyPricePointSchema).min(1),
});

export type EnergyCostCurve = z.infer<typeof EnergyCostCurveSchema>;

/**
 * Where a pack came from and whether a human signed off. AI-drafted packs
 * (extractedBy: "ai-draft") stay humanApproved: false until a human reviews
 * them in the console — nothing unapproved reaches the optimizer (the Phase I
 * AI-constraint-extraction seam, spec D4 claim 5).
 */
export const ConstraintProvenanceSchema = z.strictObject({
  origin: z.string().min(1).max(256),
  humanApproved: z.boolean(),
  extractedBy: z.enum(["human", "ai-draft"]).optional(),
});

export type ConstraintProvenance = z.infer<typeof ConstraintProvenanceSchema>;

/**
 * A versioned pack of external constraints consumed by the scheduler's
 * constrained optimum (spec D1 packages/constraints): energy tariffs, weather
 * windows, site access/noise rules, customer SLA windows.
 */
export const ExternalConstraintPackSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  packId: EntityIdSchema,
  source: ConstraintSourceSchema,
  appliesTo: SiteSelectorSchema,
  hard: z.array(HardConstraintSchema),
  soft: z.array(WeightedConstraintSchema),
  costTerms: z.array(EnergyCostCurveSchema),
  provenance: ConstraintProvenanceSchema,
});

export type ExternalConstraintPack = z.infer<typeof ExternalConstraintPackSchema>;
