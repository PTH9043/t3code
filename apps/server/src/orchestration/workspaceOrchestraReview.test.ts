import { expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type WorkspaceCollaborationRun,
  type WorkspaceOrchestraPlanEdit,
} from "@t3tools/contracts";
import {
  buildInitialWorkspaceTaskGraph,
  materializeWorkspaceTaskGraphPlan,
  parseWorkspaceTaskGraphProposal,
} from "./workspaceTaskGraph.ts";
import { reviewWorkspaceOrchestraPlan } from "./workspaceOrchestraReview.ts";
const at = "2026-10-21T00:00:00.000Z";
function run(): WorkspaceCollaborationRun {
  const graph = buildInitialWorkspaceTaskGraph("task");
  const bindings = (["coordinator", "researcher", "implementer"] as const).map((role) => ({
    projectId: ProjectId.make("project"),
    role,
    displayName: role,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    instructions: "",
    enabled: true,
    updatedAt: at,
  }));
  const proposal = parseWorkspaceTaskGraphProposal(
    "<t3_task_graph>" +
      JSON.stringify({
        summary: "plan",
        nextAction: "start",
        nodes: ["a", "b"].map((id) => ({
          id,
          kind: "implementation",
          agent: "codex",
          title: id,
          task: id,
          goal: "goal",
          context: "context",
          input: "input",
          constraints: [],
          expectedOutput: "output",
          successCriteria: ["tests"],
          dependsOn: [],
          priority: 1,
        })),
      }) +
      "</t3_task_graph>",
  );
  return {
    id: WorkspaceCollaborationRunId.make("run"),
    projectId: ProjectId.make("project"),
    source: "user",
    scheduleId: null,
    incidentId: null,
    task: "task",
    status: "running",
    steps: [],
    graph: {
      ...materializeWorkspaceTaskGraphPlan({
        graph: { ...graph, nodes: graph.nodes.map((node) => ({ ...node, status: "completed" })) },
        proposal,
        bindings,
        occurredAt: at,
      }),
      planReview: { revision: 0, status: "pending", updatedAt: at },
    },
    meeting: null,
    orchestra: { maxParallel: 2, isolateWorktrees: false, reviewPlan: true },
    finalOutput: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}
const edit = (id: string, dependsOn: string[] = []): WorkspaceOrchestraPlanEdit => ({
  nodeId: WorkspaceTaskNodeId.make(id),
  title: "edited",
  task: "edited instruction",
  participantId: null,
  dependsOn: dependsOn.map((dependency) => WorkspaceTaskNodeId.make(dependency)),
});
const input = (edits: WorkspaceOrchestraPlanEdit[] = []) => ({
  projectId: ProjectId.make("project"),
  runId: WorkspaceCollaborationRunId.make("run"),
  expectedRevision: 0,
  edits,
  approve: false,
  reviewedAt: at,
});
it("rejects cycles through validation gates, duplicate edits and unknown tasks", () => {
  expect(() =>
    reviewWorkspaceOrchestraPlan(run(), input([edit("a", ["b"]), edit("b", ["a"])])),
  ).toThrow(/순환/);
  expect(() => reviewWorkspaceOrchestraPlan(run(), input([edit("a"), edit("a")]))).toThrow(/두 번/);
  expect(() => reviewWorkspaceOrchestraPlan(run(), input([edit("missing")]))).toThrow(/실행 전/);
  expect(() => reviewWorkspaceOrchestraPlan(run(), input([edit("a", ["missing"])]))).toThrow(
    /찾을 수/,
  );
});
it("preserves independent validation, serializes dependencies through gates, and keeps retry budget", () => {
  const before = run();
  const next = reviewWorkspaceOrchestraPlan(before, input([edit("b", ["a"])]))!;
  expect(next.nodes.find((node) => node.id === "b")?.dependsOn).toEqual(["validate-a"]);
  expect(next.nodes.find((node) => node.id === "validate-b")).toEqual(
    before.graph!.nodes.find((node) => node.id === "validate-b"),
  );
  expect(next.revision).toBe(before.graph!.revision);
  expect(next.planReview).toMatchObject({ revision: 1, status: "pending" });
});
it("ignores stale, cancelled, approved and already-started plans", () => {
  const before = run();
  expect(reviewWorkspaceOrchestraPlan(before, { ...input(), expectedRevision: 1 })).toBeNull();
  expect(
    reviewWorkspaceOrchestraPlan({ ...before, status: "cancel-requested" }, input()),
  ).toBeNull();
  expect(
    reviewWorkspaceOrchestraPlan(
      {
        ...before,
        graph: { ...before.graph!, planReview: { revision: 0, status: "approved", updatedAt: at } },
      },
      input(),
    ),
  ).toBeNull();
  expect(
    reviewWorkspaceOrchestraPlan(
      {
        ...before,
        graph: {
          ...before.graph!,
          nodes: before.graph!.nodes.map((node) =>
            node.id === "a" ? { ...node, status: "running" } : node,
          ),
        },
      },
      input(),
    ),
  ).toBeNull();
});
