/**
 * Fleet map — pure presentational SVG over site + robot-view props. Robot
 * positions come from each robot's digital-shadow slice; robots without a
 * reported pose render in the list, not on the map. No API calls here.
 */
import { fmtPct, healthTone } from "../format";
import type { RobotView, SiteView } from "../api/types";
import { Badge, EmptyState, Panel } from "./ui";

const MAP_WIDTH = 900;
const MAP_HEIGHT = 560;
const PADDING = 70;

interface PositionedPoint {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Projects lat/lon points into the SVG viewBox (lat up = y up), normalizing
 * over the combined bounding box so sites and robots share one scale.
 */
export function projectPoints(
  points: readonly PositionedPoint[],
  width: number,
  height: number,
  padding: number,
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  if (points.length === 0) {
    return [];
  }
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const spanLat = maxLat - minLat || 1;
  const spanLon = maxLon - minLon || 1;
  return points.map((point) => ({
    x: padding + ((point.lon - minLon) / spanLon) * (width - 2 * padding),
    y: height - padding - ((point.lat - minLat) / spanLat) * (height - 2 * padding),
  }));
}

export function FleetMap(props: { sites: readonly SiteView[]; robots: readonly RobotView[] }) {
  const { sites, robots } = props;
  const posed = robots.flatMap((view) => {
    const pose = view.shadow?.pose;
    return pose == null ? [] : [{ view, lat: pose.lat, lon: pose.lon, batteryPct: view.shadow?.batteryPct ?? null }];
  });

  const combined: readonly PositionedPoint[] = [
    ...sites.map((site) => ({ lat: site.lat, lon: site.lon })),
    ...posed.map((entry) => ({ lat: entry.lat, lon: entry.lon })),
  ];
  const projected = projectPoints(combined, MAP_WIDTH, MAP_HEIGHT, PADDING);
  const sitePoints = projected.slice(0, sites.length);
  const robotPoints = projected.slice(sites.length);

  return (
    <Panel title="Fleet map" subtitle="Robot positions from the digital shadow; marker color is health, label is battery">
      {sites.length === 0 && posed.length === 0 ? (
        <EmptyState message="No sites or robot positions yet — telemetry pending." />
      ) : (
        <svg className="fleet-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Fleet map">
          {sites.map((site, index) => {
            const point = sitePoints[index];
            if (point === undefined) {
              return null;
            }
            return (
              <g key={site.siteId} data-testid={`site-${site.siteId}`}>
                <rect x={point.x - 16} y={point.y - 16} width={32} height={32} rx={7} className="map-site" />
                <text x={point.x} y={point.y - 24} textAnchor="middle" className="map-label">
                  {site.name}
                </text>
              </g>
            );
          })}
          {posed.map((entry, index) => {
            const point = robotPoints[index];
            if (point === undefined) {
              return null;
            }
            return (
              <g key={entry.view.robot.robotId} data-testid={`robot-${entry.view.robot.robotId}`}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={13}
                  className={`map-robot map-robot-${entry.view.health}`}
                  aria-label={`${entry.view.robot.robotId} health ${entry.view.health}`}
                />
                <text x={point.x} y={point.y + 4} textAnchor="middle" className="map-robot-battery">
                  {entry.batteryPct == null ? "–" : fmtPct(entry.batteryPct / 100)}
                </text>
                <text x={point.x} y={point.y - 20} textAnchor="middle" className="map-label">
                  {entry.view.robot.robotId}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <p className="map-legend">
        <Badge tone="green">healthy</Badge> <Badge tone="red">degraded</Badge> <Badge tone="gray">unknown</Badge>
        <span className="legend-note">
          {robots.length - posed.length} of {robots.length} robot(s) without a reported position
        </span>
      </p>
      {robots.some((view) => view.health === "degraded") ? (
        <p className="map-degraded-note">
          Degraded robots are excluded from optimization until fresh telemetry confirms recovery.{" "}
          {robots.filter((view) => healthTone(view.health) === "red").length} degraded.
        </p>
      ) : null}
    </Panel>
  );
}
