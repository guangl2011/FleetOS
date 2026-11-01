import { z } from "zod";

/**
 * The normalization contract: what a robot can do, physically and
 * operationally. The scheduler reads capability records — never vendor
 * specifics (spec D1). Evolves additively within schema major 1.
 */

/** Task vocabulary a robot can be scheduled for. */
export const TASK_TYPES = ["mow", "scrub", "inspect"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TaskTypeSchema = z.enum(TASK_TYPES);

/** Coarse robot categories the ontology spans (mowing first, scrubbing next). */
export const ROBOT_KINDS = ["mower", "scrubber", "inspection-rover"] as const;
export type RobotKind = (typeof ROBOT_KINDS)[number];
export const RobotKindSchema = z.enum(ROBOT_KINDS);

/**
 * Normalized operational weather states — scheduler-facing tolerances, not a
 * forecast. Vendor weather encodings are mapped into these by the adapter.
 */
export const WEATHER_CONDITIONS = ["clear", "light-rain", "wet-grass"] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];
export const WeatherConditionSchema = z.enum(WEATHER_CONDITIONS);

/**
 * Explicit allow-list of commands a vendor integration can send. A dispatch
 * plan may only issue commands that appear here (spec schedulability rule).
 */
export const COMMAND_PERMISSIONS = [
  "START_TASK",
  "PAUSE",
  "RESUME",
  "DOCK_CHARGE",
  "RETURN_HOME",
  "SET_NO_GO_ZONE",
  "ABORT",
] as const;
export type CommandPermission = (typeof COMMAND_PERMISSIONS)[number];
export const CommandPermissionSchema = z.enum(COMMAND_PERMISSIONS);

export const RobotCapabilitySchema = z.strictObject({
  /** Robot is schedulable for a task iff taskTypes ⊇ task.requirements.taskTypes. */
  taskTypes: z.array(TaskTypeSchema).min(1),
  maxSlopeDeg: z.number().min(0).max(90),
  batteryWh: z.number().positive(),
  nominalPowerWhPerHour: z.number().positive(),
  /** Hours to charge from 10% to 100%: [typical, worst-case]. */
  chargeHours: z
    .tuple([z.number().positive(), z.number().positive()])
    .refine(([typical, worst]) => typical <= worst, {
      message: "chargeHours must be [typical, worst-case] with typical <= worst-case",
    }),
  weatherTolerance: z.array(WeatherConditionSchema).min(1),
  /** Can the robot honor dynamic geofences? */
  noGoZones: z.boolean(),
  /** Can it resume work without an on-site human? */
  remoteResume: z.boolean(),
});

export type RobotCapability = z.infer<typeof RobotCapabilitySchema>;
