/**
 * Fleet list — the mixed-vendor fleet grouped by vendor. Grouping by vendor is
 * what makes "3 fleets on one screen" visible (spec demo bar); every row is a
 * normalized RobotView, never vendor specifics. Pure props, no API calls.
 */
import { fmtPct, healthTone } from "../format";
import type { RobotView } from "../api/types";
import { Badge, EmptyState, Panel } from "./ui";

export interface VendorGroup {
  readonly vendor: string;
  readonly views: readonly RobotView[];
}

/** Groups robot views by vendor, preserving first-seen vendor order. */
export function groupByVendor(robots: readonly RobotView[]): readonly VendorGroup[] {
  const groups = new Map<string, RobotView[]>();
  for (const view of robots) {
    const list = groups.get(view.robot.vendor);
    if (list === undefined) {
      groups.set(view.robot.vendor, [view]);
    } else {
      list.push(view);
    }
  }
  return [...groups.entries()].map(([vendor, views]) => ({ vendor, views }));
}

export function FleetList(props: { robots: readonly RobotView[] }) {
  const groups = groupByVendor(props.robots);
  return (
    <Panel
      title="Fleet"
      subtitle={`${props.robots.length} robots across ${groups.length} vendor fleet(s) — one normalized view`}
    >
      {props.robots.length === 0 ? (
        <EmptyState message="No robots registered." />
      ) : (
        groups.map((group) => (
          <div key={group.vendor} className="vendor-group">
            <h3 className="vendor-header">
              {group.vendor} <span className="vendor-count">({group.views.length})</span>
            </h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>Model</th>
                  <th>Health</th>
                  <th>Battery</th>
                  <th>State</th>
                  <th>Confidence</th>
                  <th>Current task</th>
                  <th>FCC</th>
                </tr>
              </thead>
              <tbody>
                {group.views.map((view) => (
                  <tr key={view.robot.robotId} data-testid={`fleet-row-${view.robot.robotId}`}>
                    <td className="mono">
                      {view.robot.robotId}
                      {view.shadow?.activeFault != null ? (
                        <span title={view.shadow.activeFault.type}>
                          {" "}
                          <Badge tone="amber">{view.shadow.activeFault.type}</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {view.robot.model} <span className="muted">({view.robot.kind})</span>
                    </td>
                    <td>
                      <Badge tone={healthTone(view.health)}>{view.health}</Badge>
                    </td>
                    <td>{view.shadow?.batteryPct == null ? "–" : fmtPct(view.shadow.batteryPct / 100)}</td>
                    <td>{view.shadow?.state ?? "–"}</td>
                    <td>
                      <span className="confidence-cell">
                        <span className="confidence-bar" aria-hidden="true">
                          <span
                            className="confidence-fill"
                            style={{ width: `${Math.round(view.confidence * 100)}%` }}
                          />
                        </span>
                        {fmtPct(view.confidence)}
                      </span>
                    </td>
                    <td className="mono">{view.shadow?.currentTaskId ?? "–"}</td>
                    <td>
                      <Badge tone={view.robot.compliance.fccStatus === "authorized" ? "green" : "amber"}>
                        {view.robot.compliance.fccStatus}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Panel>
  );
}
