// @vitest-environment jsdom
import "../test/setup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { exampleRobots, degradedRobotView } from "../test/fixtures";
import { FleetList, groupByVendor } from "./FleetList";

describe("groupByVendor", () => {
  it("groups robots by vendor preserving first-seen vendor order", () => {
    const groups = groupByVendor([
      ...exampleRobots,
      degradedRobotView(), // second greenworks robot joins the existing group
    ]);
    expect(groups.map((group) => group.vendor)).toEqual([
      "greenworks-sim",
      "navimow-sim",
      "husqvarna-sim",
    ]);
    expect(groups[0]?.views).toHaveLength(2);
  });
});

describe("FleetList", () => {
  it("renders one vendor group per fleet with all robots", () => {
    render(<FleetList robots={exampleRobots} />);
    expect(screen.getByText(/3 robots across 3 vendor fleet/)).toBeInTheDocument();
    for (const robotId of exampleRobots.map((view) => view.robot.robotId)) {
      expect(screen.getByTestId(`fleet-row-${robotId}`)).toBeInTheDocument();
    }
  });

  it("surfaces an active fault as a badge on the robot row", () => {
    render(<FleetList robots={[degradedRobotView()]} />);
    expect(screen.getByText("COMMS_LOST")).toBeInTheDocument();
    expect(screen.getAllByText("degraded").length).toBeGreaterThan(0);
  });

  it("shows an empty state when the fleet is empty", () => {
    render(<FleetList robots={[]} />);
    expect(screen.getByText("No robots registered.")).toBeInTheDocument();
  });
});
