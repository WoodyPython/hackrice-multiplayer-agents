import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  TASK_STATUSES,
  taskDetailSchema,
  taskSummarySchema,
} from "@app/contracts";
import { App } from "./App";
import { stubAuthApi } from "./test-auth";
import {
  createFixtureTask,
  initialTasks,
  summarize,
  workspace,
} from "./fixtures";
import { groupTasks } from "./board";

const base = `/demo/w/${workspace.id}`;
function open(path = base) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App authApi={stubAuthApi()} />
    </MemoryRouter>,
  );
}

describe("A01 workspace shell", () => {
  it("keeps fixtures valid and places every shared status exactly once", () => {
    expect(initialTasks.map((task) => task.status)).toEqual([...TASK_STATUSES]);
    initialTasks.forEach((task) => {
      expect(taskDetailSchema.safeParse(task).success).toBe(true);
      expect(taskSummarySchema.safeParse(summarize(task)).success).toBe(true);
    });
    const groups = groupTasks(initialTasks.map(summarize));
    expect(groups.map((group) => group.name)).toEqual([
      "Posted",
      "Working",
      "Needs attention",
      "Review",
      "Completed",
    ]);
    expect(
      groups
        .flatMap((group) => group.tasks)
        .map((task) => task.id)
        .sort(),
    ).toEqual(initialTasks.map((task) => task.id).sort());
    expect(
      groups
        .find((group) => group.name === "Completed")!
        .tasks.map((task) => task.status),
    ).toEqual(["completed"]);
  });

  it("filters the board and recovers from a no-results state", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(
      screen.getByLabelText("Filter by status"),
      "needs_input",
    );
    expect(
      screen.getByRole("link", { name: /Clarify the launch audience/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /Write the launch announcement/ }),
    ).toBeNull();
    await user.type(screen.getByRole("searchbox"), "unmatched");
    expect(screen.getByText("No matching tasks")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      screen.getByRole("link", { name: /Write the launch announcement/ }),
    ).toBeTruthy();
  });

  it("validates requirements, preserves selected inputs, and opens an inert posted task", async () => {
    const user = userEvent.setup();
    open(`${base}/tasks/new`);
    await user.click(screen.getByRole("button", { name: "Post task" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.type(
      screen.getByLabelText(/Task title/),
      "Write a contributor guide",
    );
    await user.type(
      screen.getByLabelText("Desired outcome"),
      "Make onboarding welcoming.",
    );
    expect(screen.queryByLabelText("Acceptance criteria")).toBeNull();
    await user.click(screen.getByLabelText(/Launch brief.md/));
    await user.click(screen.getByLabelText(/README.md/));
    await user.click(screen.getByLabelText(/Landing copy.md/));
    await user.type(
      screen.getByLabelText(/Intended output paths/),
      "../unsafe.md",
    );
    await user.click(screen.getByRole("button", { name: "Post task" }));
    expect(screen.getByText("path must not traverse upward")).toBeTruthy();
    await user.clear(screen.getByLabelText(/Intended output paths/));
    await user.type(
      screen.getByLabelText(/Intended output paths/),
      "documents/contributing.md",
    );
    await user.click(screen.getByRole("button", { name: "Post task" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Write a contributor guide",
    );
    expect(screen.getByText("Posted", { exact: true })).toBeTruthy();
    expect(screen.queryByText(/Version 1/)).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("documents/contributing.md")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("tab", { name: "Discussion" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await user.click(screen.getByRole("link", { name: /All tasks/ }));
    expect(
      within(screen.getByRole("region", { name: "Posted" })).getByRole("link", {
        name: /Write a contributor guide/,
      }),
    ).toBeTruthy();
  });

  it("creates no run when a fixture task is posted", () => {
    const task = createFixtureTask({
      kind: "agent_task",
      title: "New work",
      outcome: "",
      criteria: [],
      outputPaths: [],
      inputs: [],
      creatorGuestLabel: "Guest Maple",
    });
    expect(task.status).toBe("posted");
    expect(task.activeRunId).toBeNull();
    expect(task.discussionSeq).toBe(0);
  });

  it("supports direct task routes and keyboard tabs without a start action during work", async () => {
    const user = userEvent.setup();
    open(`${base}/tasks/${initialTasks[2]!.id}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      initialTasks[2]!.title,
    );
    expect(screen.queryByRole("button", { name: "Start task" })).toBeNull();
    screen.getByRole("tab", { name: "Discussion" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "Drafts" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain(
      "A place for work in progress",
    );
  });

  it("exposes loading, empty, and recoverable error previews", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(screen.getByLabelText("Preview state"), "loading");
    expect(screen.getByRole("status").textContent).toBe("Loading workspace…");
    await user.selectOptions(screen.getByLabelText("Preview state"), "empty");
    expect(screen.getByText("Make room for your first idea.")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Preview state"), "error");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Task board")).toBeTruthy();
  });

  it("shows a missing-task state instead of substituting another task", () => {
    open(`${base}/tasks/missing`);
    expect(screen.getByText("Task not found")).toBeTruthy();
  });

  it("navigates to files, history, and workspace settings", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("link", { name: "Files" }));
    expect(
      screen.getByRole("heading", { name: "Reference materials" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "History" }));
    expect(screen.getByRole("heading", { name: "History" })).toBeTruthy();
    // Settings is a sidebar link, no longer inside the workspace card's menu.
    await user.click(screen.getByRole("link", { name: "Workspace settings" }));
    expect(
      screen.getByRole("heading", { name: "Workspace guidance" }),
    ).toBeTruthy();
  });
});


it("shows only completed tasks and their column when filtered", async () => {
  const user = userEvent.setup();
  open();
  await user.selectOptions(screen.getByLabelText("Filter by status"), "completed");
  expect(screen.getByRole("region", { name: "Completed" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Working" })).toBeNull();
  expect(screen.queryByRole("link", { name: /Write the launch announcement/ })).toBeNull();
});


it("keeps saved changes in Review and lets demo users toggle completion", async () => {
  const user = userEvent.setup();
  open();
  expect(screen.queryByRole("region", { name: "Final confirmation" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Review" })).getByText("Give the launch checklist a final look")).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("Filter by status"), "ready_for_review");
  expect(screen.getByText("Give the launch checklist a final look")).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("Filter by status"), "all");
  await user.click(screen.getByRole("link", { name: /Write the launch announcement/ }));
  await user.click(screen.getByRole("button", { name: "Mark as Complete" }));
  await user.click(screen.getByRole("button", { name: "Unmark as Complete" }));
  expect(screen.getByRole("button", { name: "Mark as Complete" })).toBeTruthy();
});
