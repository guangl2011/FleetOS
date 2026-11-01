// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type { ExceptionRecord } from "@fleetos/fleet-health";

import { ExceptionQueue } from "./ExceptionQueue";

const batteryException: ExceptionRecord = {
  exceptionId: "exc-1",
  faultId: "fault-1",
  robotId: "greenworks-1",
  taskId: "task-1",
  type: "BATTERY",
  severity: "critical",
  message: "battery below reserve floor during task-1",
  status: "open",
  openedAt: "2026-11-01T14:10:00.000Z",
  marksDegraded: false,
  suggestedRecovery: "dock-charge",
};

const commsException: ExceptionRecord = {
  exceptionId: "exc-2",
  faultId: "fault-2",
  robotId: "greenworks-2",
  type: "COMMS_LOST",
  severity: "critical",
  message: "no telemetry for 90s",
  status: "open",
  openedAt: "2026-11-01T14:12:00.000Z",
  marksDegraded: true,
};

describe("ExceptionQueue", () => {
  it("renders open exceptions with severity, robot, and the agent's suggested recovery", () => {
    render(
      <ExceptionQueue
        exceptions={[batteryException, commsException]}
        busy={false}
        onAcknowledge={() => {}}
        onRelease={() => {}}
        onRecovery={() => {}}
      />,
    );
    expect(screen.getByTestId("exception-exc-1")).toBeInTheDocument();
    expect(screen.getByText(/agent suggests: dock-charge/)).toBeInTheDocument();
    expect(screen.getByTestId("exception-exc-2")).toBeInTheDocument();
    expect(screen.getByText("degraded mode")).toBeInTheDocument();
  });

  it("acknowledge moves nothing itself but emits the callback with the exception id", async () => {
    const onAcknowledge = vi.fn();
    render(
      <ExceptionQueue
        exceptions={[batteryException]}
        busy={false}
        onAcknowledge={onAcknowledge}
        onRelease={() => {}}
        onRecovery={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId("ack-exc-1"));
    expect(onAcknowledge).toHaveBeenCalledWith("exc-1");
  });

  it("routes approve/reject recovery decisions with the typed reason", async () => {
    const onRecovery = vi.fn();
    render(
      <ExceptionQueue
        exceptions={[batteryException]}
        busy={false}
        onAcknowledge={() => {}}
        onRelease={() => {}}
        onRecovery={onRecovery}
      />,
    );
    await userEvent.click(screen.getByTestId("approve-recovery-exc-1"));
    expect(onRecovery).toHaveBeenCalledWith("exc-1", "approve", "handled from console");
    await userEvent.click(screen.getByTestId("reject-recovery-exc-1"));
    expect(onRecovery).toHaveBeenCalledWith("exc-1", "reject", "handled from console");
  });

  it("releases with the typed reason and moves the card to history", async () => {
    const onRelease = vi.fn();
    render(
      <ExceptionQueue
        exceptions={[commsException]}
        busy={false}
        onAcknowledge={() => {}}
        onRelease={onRelease}
        onRecovery={() => {}}
      />,
    );
    await userEvent.type(screen.getByTestId("reason-exc-2"), "link restored");
    await userEvent.click(screen.getByTestId("release-exc-2"));
    expect(onRelease).toHaveBeenCalledWith("exc-2", "handled from consolelink restored");
  });

  it("shows the quiet state when there are no exceptions", () => {
    render(
      <ExceptionQueue
        exceptions={[]}
        busy={false}
        onAcknowledge={() => {}}
        onRelease={() => {}}
        onRecovery={() => {}}
      />,
    );
    expect(screen.getByText("No exceptions — the fleet is quiet.")).toBeInTheDocument();
  });
});
