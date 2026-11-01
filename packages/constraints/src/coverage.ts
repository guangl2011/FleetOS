import type {
  DailyWindow,
  ExternalConstraintPack,
  RobotKind,
  SiteSelector,
} from "@fleetos/core-schema";
import { WEATHER_CONDITIONS } from "@fleetos/core-schema";

const MINUTES_PER_DAY = 24 * 60;
const DAYS_PER_WEEK = 7;

/**
 * Why a scope can never be scheduled. "all-time-forbidden": hard time-window
 * constraints cover every minute of every day. "all-weather-forbidden":
 * weather cutoffs forbid every weather condition that exists.
 */
export type InfeasibilityReason = "all-time-forbidden" | "all-weather-forbidden";

export interface InfeasibleScopeFinding {
  /** Specific site, or null when only site-agnostic packs are involved. */
  readonly siteId: string | null;
  /** Specific robot kind, or null when only kind-agnostic packs are involved. */
  readonly robotKind: RobotKind | null;
  readonly packIds: readonly string[];
  readonly reason: InfeasibilityReason;
}

export interface SelectorContext {
  readonly siteId?: string;
  readonly robotKind?: RobotKind;
}

/**
 * Whether a pack's selector applies to a site/robot-kind context. A selector
 * dimension left unset is fleet-wide for that dimension; an explicit list
 * never matches an unknown (undefined) context value — the scheduler asks
 * about concrete robots, so unknown there means "no evidence of a match".
 */
export function packAppliesTo(pack: ExternalConstraintPack, context: SelectorContext): boolean {
  return selectorMatches(pack.appliesTo, context.siteId, context.robotKind);
}

function selectorMatches(
  selector: SiteSelector,
  siteId: string | undefined,
  robotKind: RobotKind | undefined,
): boolean {
  const siteOk =
    selector.siteIds === undefined || (siteId !== undefined && selector.siteIds.includes(siteId));
  const kindOk =
    selector.robotKinds === undefined ||
    (robotKind !== undefined && selector.robotKinds.includes(robotKind));
  return siteOk && kindOk;
}

function appliesOnDay(window: DailyWindow, day: number): boolean {
  return window.daysOfWeek === undefined || window.daysOfWeek.includes(day);
}

/** "HH:MM" (Zod-validated) → minutes since midnight. */
function minutes(timeOfDay: string): number {
  const [hh, mm] = timeOfDay.split(":");
  return Number(hh) * 60 + Number(mm);
}

/**
 * Marks a forbidden window on one day's minute grid. Windows are half-open
 * [start, end); start > end wraps midnight and is split at 24:00. A
 * start === end window is ambiguous and rejected by validation, so it is
 * skipped here rather than guessed at.
 */
function markForbidden(grid: boolean[], window: DailyWindow): void {
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === end) {
    return;
  }
  if (start < end) {
    for (let m = start; m < end; m++) {
      grid[m] = true;
    }
    return;
  }
  for (let m = start; m < MINUTES_PER_DAY; m++) {
    grid[m] = true;
  }
  for (let m = 0; m < end; m++) {
    grid[m] = true;
  }
}

function allTimeForbidden(packs: readonly ExternalConstraintPack[]): boolean {
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    const grid: boolean[] = new Array<boolean>(MINUTES_PER_DAY).fill(false);
    for (const pack of packs) {
      for (const constraint of pack.hard) {
        if (constraint.rule !== "time-window") {
          continue;
        }
        for (const window of constraint.forbiddenWindows) {
          if (appliesOnDay(window, day)) {
            markForbidden(grid, window);
          }
        }
      }
    }
    // One workable minute on any day keeps the scope feasible.
    if (grid.some((forbidden) => !forbidden)) {
      return false;
    }
  }
  return true;
}

function allWeatherForbidden(packs: readonly ExternalConstraintPack[]): boolean {
  const forbidden = new Set<string>();
  for (const pack of packs) {
    for (const constraint of pack.hard) {
      if (constraint.rule === "weather-cutoff") {
        for (const condition of constraint.forbiddenConditions) {
          forbidden.add(condition);
        }
      }
    }
  }
  return WEATHER_CONDITIONS.every((condition) => forbidden.has(condition));
}

/**
 * Detects scopes whose combined hard constraints make work impossible —
 * the "overlapping-infeasible" case: packs that are individually valid but
 * jointly leave no schedulable time (or no weather) for some site/kind.
 *
 * Complete by construction: a pack only reaches a scope (site, kind) through
 * an unset (fleet-wide) or explicit selector entry, so enumerating every
 * mentioned site/kind plus the fleet-wide sentinel covers every distinct
 * applicability profile.
 */
export function findInfeasibleScopes(
  packs: readonly ExternalConstraintPack[],
): readonly InfeasibleScopeFinding[] {
  const sites = new Set<string>();
  const kinds = new Set<RobotKind>();
  for (const pack of packs) {
    for (const siteId of pack.appliesTo.siteIds ?? []) {
      sites.add(siteId);
    }
    for (const robotKind of pack.appliesTo.robotKinds ?? []) {
      kinds.add(robotKind);
    }
  }
  // Sorted candidates keep the findings order independent of input order.
  const siteCandidates: (string | null)[] = [[...sites].sort(), null].flat();
  const kindCandidates: (RobotKind | null)[] = [[...kinds].sort(), null].flat();

  const findings: InfeasibleScopeFinding[] = [];
  for (const siteId of siteCandidates) {
    for (const robotKind of kindCandidates) {
      const applicable = packs.filter((pack) =>
        selectorMatches(pack.appliesTo, siteId ?? undefined, robotKind ?? undefined),
      );
      if (applicable.length === 0) {
        continue;
      }
      const reason: InfeasibilityReason | undefined = allTimeForbidden(applicable)
        ? "all-time-forbidden"
        : allWeatherForbidden(applicable)
          ? "all-weather-forbidden"
          : undefined;
      if (reason !== undefined) {
        findings.push({
          siteId,
          robotKind,
          packIds: applicable.map((pack) => pack.packId).sort(),
          reason,
        });
      }
    }
  }
  return findings;
}
