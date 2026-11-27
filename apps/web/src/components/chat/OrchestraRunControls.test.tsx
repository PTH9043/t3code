import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, WorkspaceCollaborationRunId } from "@t3tools/contracts";
import type { WorkspaceCollaborationRun } from "@t3tools/contracts";
import { OrchestraRunControls } from "./OrchestraRunControls";

vi.mock("~/state/projects", () => ({
  projectEnvironment: { reviewWorkspaceCollaborationRun: "review" },
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { workspaceCollaborationRuns: () => "runs" },
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ refresh: () => {} }) }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../control-center/controlCenterShared", () => ({
  notifyCommandFailure: () => false,
  notifySuccess: () => {},
}));
vi.mock("../control-center/WorktreeDiffDialog", () => ({ WorktreeDiffDialog: () => null }));
vi.mock("./WorkspaceAgentControlPanel", () => ({ WorkspaceAgentControlPanel: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

it("shows a refused workflow's unassigned step as pending rather than selected for the chair", () => {
  const run = {
    id: WorkspaceCollaborationRunId.make("run"),
    projectId: ProjectId.make("project"),
    status: "running",
    graph: {
      planReview: { revision: 0, status: "pending" },
      workflowAssignment: { gateNodeId: "plan", pendingNodeIds: ["unassigned"] },
      nodes: [
        {
          id: "plan",
          kind: "orchestration",
          validationTargetId: null,
          dependsOn: [],
          threadId: null,
        },
        {
          id: "unassigned",
          title: "미배정 업무",
          kind: "implementation",
          handoff: { task: "지시" },
          participantId: null,
          validationTargetId: null,
          dependsOn: ["plan"],
          threadId: null,
        },
      ],
    },
    meeting: {
      threadId: null,
      participants: [
        { id: "chair", displayName: "감독", modelSelection: { model: "supervisor" } },
        { id: "worker", displayName: "작업자", modelSelection: { model: "worker" } },
      ],
    },
  } as unknown as WorkspaceCollaborationRun;
  const html = renderToStaticMarkup(
    <OrchestraRunControls environmentId={EnvironmentId.make("env")} run={run} />,
  );
  expect(html).toContain('value="" selected=""');
  expect(html).toContain("감독자 배정 대기");
  expect(html).not.toContain('value="chair" selected=""');
});
