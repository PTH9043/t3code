import { Children, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type WorkspaceCollaborationRun } from "@t3tools/contracts";
import { WorkflowRunControls } from "./WorkflowRunControls";

const state = vi.hoisted(() => ({
  buttons: [] as Array<{ label: string; onClick: (() => void) | undefined }>,
  command: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock("../ui/button", () => ({
  Button: (props: { children?: ReactNode; onClick?: () => void }) => {
    state.buttons.push({
      label: Children.toArray(props.children)
        .filter((item) => typeof item === "string")
        .join(""),
      onClick: props.onClick,
    });
    return <button>{props.children}</button>;
  },
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { controlWorkflow: "control" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.command }));

const environmentId = EnvironmentId.make("environment");
const baseRun = {
  id: "workflow-run",
  projectId: "project",
  status: "running",
  workflow: { title: "저장된 작업", definitionRevision: 3, control: "active", controlRevision: 7 },
  graph: null,
} as unknown as WorkspaceCollaborationRun;
const refresh = vi.fn();

beforeEach(() => {
  state.buttons.length = 0;
  state.command.mockClear();
  refresh.mockClear();
});

it("pauses the same workflow run with its current control revision", async () => {
  renderToStaticMarkup(
    <WorkflowRunControls environmentId={environmentId} run={baseRun} onRefresh={refresh} />,
  );
  state.buttons.find((button) => button.label === "일시정지")?.onClick?.();
  expect(state.command).toHaveBeenCalledWith({
    environmentId,
    input: { projectId: "project", runId: "workflow-run", expectedRevision: 7, action: "pause" },
  });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it("resumes a paused workflow using its current control revision", async () => {
  const run = {
    ...baseRun,
    workflow: { ...baseRun.workflow!, control: "paused", controlRevision: 8 },
  } as WorkspaceCollaborationRun;
  renderToStaticMarkup(
    <WorkflowRunControls environmentId={environmentId} run={run} onRefresh={refresh} />,
  );
  state.buttons.find((button) => button.label === "재개")?.onClick?.();
  expect(state.command).toHaveBeenCalledWith({
    environmentId,
    input: {
      projectId: "project",
      runId: "workflow-run",
      expectedRevision: 8,
      action: "resume",
    },
  });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it("retries the selected failed node using the same run and revision", async () => {
  const run = {
    ...baseRun,
    status: "failed",
    graph: { nodes: [{ id: "node-1", title: "구현", status: "failed", attempts: [{}] }] },
  } as unknown as WorkspaceCollaborationRun;
  renderToStaticMarkup(
    <WorkflowRunControls environmentId={environmentId} run={run} onRefresh={refresh} />,
  );
  state.buttons.find((button) => button.label === "구현 재시도")?.onClick?.();
  expect(state.command).toHaveBeenCalledWith({
    environmentId,
    input: {
      projectId: "project",
      runId: "workflow-run",
      expectedRevision: 7,
      action: "retry",
      nodeId: "node-1",
    },
  });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});
