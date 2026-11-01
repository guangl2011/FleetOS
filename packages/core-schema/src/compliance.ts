import { z } from "zod";

import { CountryCodeSchema, FieldNameSchema, IsoDateSchema, RegionSchema } from "./primitives.js";

/**
 * Compliance by design (spec data-compliance chapter): the FCC Covered List
 * action of 2026-07-28 made per-device posture an operational property, so it
 * is a first-class part of the robot record — not paperwork.
 */

/**
 * Per-model FCC equipment-authorization posture:
 * - "authorized" — current FCC equipment authorization on file.
 * - "waived-update-window" — model added to the Covered List by the
 *   2026-07-28 action; it keeps operating with firmware updates waived until
 *   the recorded expiry (>= 2029-01-01 for existing models).
 * - "unauthorized" — no FCC authorization on file.
 */
export const FCC_STATUSES = ["authorized", "waived-update-window", "unauthorized"] as const;
export type FccStatus = (typeof FCC_STATUSES)[number];
export const FccStatusSchema = z.enum(FCC_STATUSES);

/** Where telemetry may be stored and whether it may leave the operator's region. */
export const DataResidencySchema = z.strictObject({
  /** Operator-chosen storage region for this robot's telemetry. */
  telemetryRegion: RegionSchema,
  allowCrossBorderTelemetry: z.boolean(),
});

/**
 * Per-device map of where the robot's data goes: which OEM cloud the
 * telemetry traverses and through which jurisdictions. Surfaced in the
 * console, never hidden (spec: cross-border OEM cloud flows).
 */
export const DataFlowProfileSchema = z.strictObject({
  /** Vendor cloud identifier, e.g. "navimow-cloud". Simulators mark themselves. */
  oemCloud: z.string().min(1).max(128),
  /** Countries the telemetry transits. */
  traversedJurisdictions: z.array(CountryCodeSchema).min(1),
  /** Minimum telemetry field set the adapter actually consumes (data minimization). */
  telemetryFieldAllowlist: z.array(FieldNameSchema).min(1),
});

export const ComplianceBlockSchema = z.strictObject({
  /** Place of production, ISO 3166-1 alpha-2 (FCC posture is place-of-production based). */
  productionOrigin: CountryCodeSchema,
  fccStatus: FccStatusSchema,
  /**
   * Firmware-update eligibility horizon: null when unrestricted, otherwise the
   * date after which new firmware updates are no longer permitted (for
   * waived models, the Covered List waiver expiry, >= 2029-01-01).
   */
  firmwareUpdateEligibleUntil: IsoDateSchema.nullable(),
  dataResidency: DataResidencySchema,
  dataFlow: DataFlowProfileSchema,
});

export type DataResidency = z.infer<typeof DataResidencySchema>;
export type DataFlowProfile = z.infer<typeof DataFlowProfileSchema>;
export type ComplianceBlock = z.infer<typeof ComplianceBlockSchema>;
