// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type { PlanRowView } from "../api/types";
import { ScheduleBoard } from "./ScheduleBoard";
import { currentPlanView, draftPlanView } from "../test/plan-fixtures";
import { exampleSites, exampleTasks } from "../test/fixtures";

function renderBoard(draftPlan: PlanRowView | null, handlers: { onGenerate?: () => void; onCommit?: () => void } = {}) {
  return render(
    <ScheduleBoard
      currentPlan={null}
      draftPlan={draftPlan}
      tasks={exampleTasks}
      sites={exampleSites}
      busy={false}
      onGenerate={handlers.onGenerate ?? (() => {})}
      onCommit={handlers.onCommit ?? (() => {})}
    />,
  );
}

describe("ScheduleBoard", () => {
  it("renders the committed plan grouped by robot with projections", () => {
    render(
      <ScheduleBoard
        currentPlan={currentPlanView()}
        draftPlan={null}
        tasks={exampleTasks}
        sites={exampleSites}
        busy={false}
        onGenerate={() => {}}
        onCommit={() => {}}
      />,
    );
    expect(screen.getByTestId("committed-plan")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-greenworks-1")).toBeInTheDocument();
    expect(screen.getByText("Committed plan")).toBeInTheDocument();
  });

  it("keeps commit disabled until a draft exists, then enables it", async () => {
    const onCommit = vi.fn();
    const first = renderBoard(null, { onCommit });
    expect(screen.getByTestId("commit-plan")).toBeDisabled();
    first.unmount();
    renderBoard(draftPlanView(), { onCommit });
    expect(screen.getByTestId("commit-plan")).toBeEnabled();
    await userEvent.click(screen.getByTestId("commit-plan"));
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("emits the selected scheduler on generate", async () => {
    const onGenerate = vi.fn();
    renderBoard(null, { onGenerate });
    await userEvent.selectOptions(screen.getByTestId("scheduler-choice"), "baseline");
    await userEvent.click(screen.getByTestId("generate-plan"));
    expect(onGenerate).toHaveBeenCalledWith("baseline");
  });
});
