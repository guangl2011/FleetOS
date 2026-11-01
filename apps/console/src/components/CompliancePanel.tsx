/**
 * Compliance panel — per-device compliance surfacing (spec data-compliance
 * chapter): place of production, FCC Covered List posture, firmware-update
 * window, data residency, and the cross-border OEM cloud data flow. Pure
 * props, no API calls.
 */
import { fccTone } from "../format";
import type { RobotView } from "../api/types";
import { Badge, EmptyState, Panel } from "./ui";

export function CompliancePanel(props: { readonly robots: readonly RobotView[] }) {
  return (
    <Panel
      title="Data compliance"
      subtitle="Per-device posture is a runtime property, not paperwork — residency, minimization, and flows surfaced to the operator"
    >
      {props.robots.length === 0 ? (
        <EmptyState message="No robots registered." />
      ) : (
        <div className="compliance-grid">
          {props.robots.map((view) => {
            const compliance = view.robot.compliance;
            return (
              <article
                key={view.robot.robotId}
                className="compliance-card"
                data-testid={`compliance-${view.robot.robotId}`}
              >
                <header className="exception-header">
                  <strong className="mono">{view.robot.robotId}</strong>
                  <Badge tone={fccTone(compliance.fccStatus)}>{compliance.fccStatus}</Badge>
                </header>
                <dl className="compliance-facts">
                  <dt>Production origin</dt>
                  <dd>{compliance.productionOrigin}</dd>
                  <dt>Firmware updates until</dt>
                  <dd>{compliance.firmwareUpdateEligibleUntil ?? "unrestricted"}</dd>
                  <dt>Telemetry region</dt>
                  <dd>
                    <Badge tone="blue">{compliance.dataResidency.telemetryRegion}</Badge>{" "}
                    {compliance.dataResidency.allowCrossBorderTelemetry ? (
                      <Badge tone="amber">cross-border allowed</Badge>
                    ) : (
                      <Badge tone="green">no cross-border</Badge>
                    )}
                  </dd>
                  <dt>OEM cloud flow</dt>
                  <dd>
                    <span className="mono">{compliance.dataFlow.oemCloud}</span> via{" "}
                    {compliance.dataFlow.traversedJurisdictions.join(", ")}
                  </dd>
                  <dt>Minimized field allowlist</dt>
                  <dd className="muted">{compliance.dataFlow.telemetryFieldAllowlist.join(", ")}</dd>
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
