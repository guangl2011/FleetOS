// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { exampleRobots, degradedRobotView } from "../test/fixtures";
import { CompliancePanel } from "./CompliancePanel";

describe("CompliancePanel", () => {
  it("surfaces per-device origin, FCC status, residency, and the OEM cloud flow", () => {
    render(<CompliancePanel robots={exampleRobots} />);
    expect(screen.getByTestId("compliance-greenworks-1")).toBeInTheDocument();
    expect(screen.getAllByText("authorized").length).toBeGreaterThan(0);
    expect(screen.getAllByText("us-west-2").length).toBe(3);
    expect(screen.getAllByText(/greenworks-cloud-sim/).length).toBeGreaterThan(0);
  });

  it("renders one card per robot", () => {
    render(<CompliancePanel robots={[...exampleRobots, degradedRobotView()]} />);
    expect(screen.getByTestId("compliance-greenworks-2")).toBeInTheDocument();
    expect(screen.getAllByText(/Production origin/).length).toBe(4);
  });

  it("shows an empty state before robots are registered", () => {
    render(<CompliancePanel robots={[]} />);
    expect(screen.getByText("No robots registered.")).toBeInTheDocument();
  });
});
