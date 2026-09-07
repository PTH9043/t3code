import { WorkspaceTaskNodeId, type WorkspaceTaskNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { layoutMobileTaskGraph } from "./mobileTaskGraphLayout";

function node(id: string, order: number, dependsOn: ReadonlyArray<string> = []): WorkspaceTaskNode {
  return {
    id: WorkspaceTaskNodeId.make(id),
    order,
    kind: "research",
    agent: "grok",
    role: "researcher",
    participantId: null,
    threadId: null,
    parkedQuestion: null,
    worktreePath: null,
    branch: null,
    title: id,
    handoff: {
      task: id,
      goal: id,
      context: "",
      input: "",
      constraints: [],
      expectedOutput: "",
      successCriteria: [],
    },
    dependsOn: dependsOn.map((dependencyId) => WorkspaceTaskNodeId.make(dependencyId)),
    validationTargetId: null,
    priority: 0,
    status: "queued",
    maxAttempts: 1,
    attempts: [],
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    validation: null,
    startedAt: null,
    completedAt: null,
  };
}

const ids = (nodes: ReadonlyArray<WorkspaceTaskNode>) =>
  nodes.map((taskNode) => String(taskNode.id));

describe("layoutMobileTaskGraph", () => {
  it("groups independent work at the same vertical stage", () => {
    const layout = layoutMobileTaskGraph([
      node("finish", 3, ["research", "build"]),
      node("build", 2, ["plan"]),
      node("plan", 0),
      node("research", 1, ["plan"]),
    ]);

    expect(layout.levels.map((level) => ids(level.nodes))).toEqual([
      ["plan"],
      ["research", "build"],
      ["finish"],
    ]);
    expect(layout.hasStructuralIssues).toBe(false);
  });

  it("keeps nodes with missing dependencies visible and reports the gap", () => {
    const layout = layoutMobileTaskGraph([node("research", 0, ["unknown"])]);

    expect(layout.levels.map((level) => ids(level.nodes))).toEqual([["research"]]);
    expect(layout.missingDependencies).toEqual([{ nodeId: "research", dependencyId: "unknown" }]);
  });

  it("moves cyclic and cycle-dependent nodes to a final safe level", () => {
    const layout = layoutMobileTaskGraph([
      node("a", 0, ["b"]),
      node("b", 1, ["a"]),
      node("downstream", 2, ["a"]),
      node("valid", 3),
    ]);

    expect(layout.levels.map((level) => ids(level.nodes))).toEqual([
      ["valid"],
      ["a", "b", "downstream"],
    ]);
    expect(layout.levels.at(-1)?.unresolved).toBe(true);
    expect(layout.unresolvedNodeIds).toEqual(["a", "b", "downstream"]);
  });
});
