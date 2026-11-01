import type {
  DailyWindow,
  ExternalConstraintPack,
  HardConstraint,
  Robot,
  WeatherCondition,
} from "@fleetos/core-schema";
import { packAppliesTo } from "@fleetos/constraints";
import type { SelectorContext } from "@fleetos/constraints";

/**
 * Hard-constraint feasibility gates (spec: "hard constraints as feasibility
 * gates"). A candidate the gate rejects is never scheduled — the objective
 * only ranks feasible candidates.
 *
 * Time windows are local wall-clock (TimeOfDay), interpreted in the site's
 * UTC offset from `SchedulingContext.localOffsetMinutes`; work is forbidden
 * inside the listed windows, windows may wrap midnight, and travel is
 * permitted inside a forbidden window (ordinances bind the work, not the
 * transit — a mower driving to its site is not mowing).
 */

const MINUTES_PER_DAY = 24 * 60;

/** Hard constraints from packs that apply to the given site/robot-kind context. */
export function applicableHardConstraints(
  packs: readonly ExternalConstraintPack[],
  context: SelectorContext,
): readonly HardConstraint[] {
  return packs.filter((pack) => packAppliesTo(pack, context)).flatMap((pack) => pack.hard);
}

/** Wall-clock minutes since local midnight for an epoch-ms instant at the given offset. */
export function localMinuteOfDay(instantMs: number, offsetMinutes: number): number {
  const totalMinutes = Math.floor((instantMs + offsetMinutes * 60_000) / 60_000);
  return ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Whether a local-clock window is "open" (forbidding) at a given minute of
 * the day. Half-open [start, end); start > end wraps midnight; start === end
 * is ambiguous and rejected by pack validation, treated as never-forbidding.
 */
export function windowContainsMinute(window: DailyWindow, minuteOfDay: number): boolean {
  const start = Number(window.start.slice(0, 2)) * 60 + Number(window.start.slice(3, 5));
  const end = Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3, 5));
  if (start === end) {
    return false;
  }
  if (start < end) {
    return minuteOfDay >= start && minuteOfDay < end;
  }
  return minuteOfDay >= start || minuteOfDay < end;
}

function weekdaysContain(window: DailyWindow, instantMs: number, offsetMinutes: number): boolean {
  if (window.daysOfWeek === undefined) {
    return true;
  }
  const localDay = new Date(instantMs + offsetMinutes * 60_000).getUTCDay();
  return window.daysOfWeek.includes(localDay);
}

/**
 * Whether any minute of `[startMs, endMs)` falls inside a forbidden window.
 * checked per-minute — windows wrap midnight, so per-day interval algebra is
 * error-prone and the worst case (a 15-hour interval) is 900 checks.
 */
export function intervalForbidden(
  startMs: number,
  endMs: number,
  windows: readonly DailyWindow[],
  offsetMinutes: number,
): boolean {
  const stepMs = 60_000;
  for (let t = startMs; t < endMs; t += stepMs) {
    for (const window of windows) {
      if (
        weekdaysContain(window, t, offsetMinutes) &&
        windowContainsMinute(window, localMinuteOfDay(t, offsetMinutes))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether any forecast condition in `[startMs, endMs)` is forbidden. Without
 * a forecast this gate is vacuous (absence of a forecast is a documented
 * limitation, not silent safety — the runtime still holds work on live
 * conditions, WEATHER_HOLD semantics).
 */
export function intervalWeatherForbidden(
  startMs: number,
  endMs: number,
  forbidden: readonly WeatherCondition[],
  forecast: readonly { from: string; condition: WeatherCondition }[] | undefined,
): boolean {
  if (forecast === undefined || forbidden.length === 0) {
    return false;
  }
  const stepMs = 60_000;
  for (let t = startMs; t < endMs; t += stepMs) {
    let current: WeatherCondition | null = null;
    for (const entry of forecast) {
      if (Date.parse(entry.from) <= t) {
        current = entry.condition;
      } else {
        break;
      }
    }
    if (current !== null && forbidden.includes(current)) {
      return true;
    }
  }
  return false;
}

/**
 * A robot may serve a task iff its capability task-types cover the task's
 * requirements and its command allow-list covers every command the dispatch
 * plan will send (spec schedulability rule; `needsCharge` plans DOCK_CHARGE).
 */
export function robotServesTask(
  robot: Robot,
  taskTypes: readonly string[],
  needsCharge: boolean,
): boolean {
  const covers = taskTypes.every((type) =>
    (robot.capabilities.taskTypes as readonly string[]).includes(type),
  );
  const commands = robot.commands as readonly string[];
  const canStart = commands.includes("START_TASK");
  const canCharge = !needsCharge || commands.includes("DOCK_CHARGE");
  return covers && canStart && canCharge;
}
