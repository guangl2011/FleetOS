// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { exampleRobots, degradedRobotView, exampleSites } from "../test/fixtures";
import { FleetMap, projectPoints } from "./FleetMap";

describe("projectPoints", () => {
  it("normalizes an arbitrary lat/lon bounding box into the viewport", () => {
    const points = projectPoints(
      [
        { lat: 38.8, lon: -77.1 },
        { lat: 39.0, lon: -77.0 },
      ],
      900,
      560,
      70,
    );
    const [first, second] = points;
    expect(first !== undefined && second !== undefined).toBe(true);
    if (first === undefined || second === undefined) {
      return;
    }
    expect(first.x).toBeLessThan(second.x);
    expect(first.y).toBeGreaterThan(second.y); // north (higher lat) is up
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(70);
      expect(point.x).toBeLessThanOrEqual(830);
      expect(point.y).toBeGreaterThanOrEqual(70);
      expect(point.y).toBeLessThanOrEqual(490);
    }
  });

  it("handles a degenerate (single-point) box without dividing by zero", () => {
    const points = projectPoints([{ lat: 38.9, lon: -77.0 }], 900, 560, 70);
    expect(points).toHaveLength(1);
    expect(Number.isFinite(points[0]?.x)).toBe(true);
    expect(Number.isFinite(points[0]?.y)).toBe(true);
  });
});

describe("FleetMap", () => {
  it("renders a marker per posed robot and labels each site", () => {
    render(<FleetMap sites={exampleSites} robots={exampleRobots} />);
    expect(screen.getByTestId("site-site-1")).toBeInTheDocument();
    expect(screen.getByTestId("site-site-3")).toBeInTheDocument();
    expect(screen.getByTestId("robot-greenworks-1")).toBeInTheDocument();
    expect(screen.getByTestId("robot-navimow-1")).toBeInTheDocument();
    expect(screen.getByTestId("robot-husqvarna-1")).toBeInTheDocument();
  });

  it("counts robots without a reported position and never renders them", () => {
    render(<FleetMap sites={exampleSites} robots={[degradedRobotView()]} />);
    expect(screen.queryByTestId("robot-greenworks-2")).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 1 robot\(s\) without a reported position/)).toBeInTheDocument();
  });

  it("flags degraded robots in the legend", () => {
    render(<FleetMap sites={exampleSites} robots={[degradedRobotView()]} />);
    expect(screen.getByText(/Degraded robots are excluded from optimization/)).toBeInTheDocument();
  });
});
