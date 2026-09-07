import { WorkspaceTaskNodeId, type WorkspaceTaskNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { layoutWorkspaceTaskGraph } from "./workspaceTaskGraphLayout";

function taskNode(
  id: string,
  order: number,
  dependsOn: ReadonlyArray<string> = [],
): WorkspaceTaskNode {
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

function columnIds(nodes: ReadonlyArray<WorkspaceTaskNode>) {
  return nodes.map((node) => String(node.id));
}

describe("layoutWorkspaceTaskGraph", () => {
  it("places independent nodes in parallel lanes at the same topological depth", () => {
    const layout = layoutWorkspaceTaskGraph([
      taskNode("synthesis", 4, ["research", "implementation"]),
      taskNode("implementation", 3, ["plan"]),
      taskNode("plan", 0),
      taskNode("research", 2, ["plan"]),
      taskNode("context", 1),
    ]);

    expect(layout.columns.map((column) => columnIds(column.nodes))).toEqual([
      ["plan", "context"],
      ["research", "implementation"],
      ["synthesis"],
    ]);
    expect(layout.hasStructuralIssues).toBe(false);
  });

  it("keeps a node visible when one of its dependencies is missing", () => {
    const layout = layoutWorkspaceTaskGraph([taskNode("research", 0, ["missing"])]);

    expect(layout.columns.map((column) => columnIds(column.nodes))).toEqual([["research"]]);
    expect(layout.missingDependencies).toEqual([{ nodeId: "research", dependencyId: "missing" }]);
    expect(layout.hasStructuralIssues).toBe(true);
  });

  it("isolates cyclic and cycle-dependent nodes without hiding valid columns", () => {
    const layout = layoutWorkspaceTaskGraph([
      taskNode("cycle-a", 0, ["cycle-b"]),
      taskNode("cycle-b", 1, ["cycle-a"]),
      taskNode("downstream", 2, ["cycle-a"]),
      taskNode("valid-root", 3),
      taskNode("valid-child", 4, ["valid-root"]),
    ]);

    expect(layout.columns.map((column) => columnIds(column.nodes))).toEqual([
      ["valid-root"],
      ["valid-child"],
      ["cycle-a", "cycle-b", "downstream"],
    ]);
    expect(layout.columns.at(-1)?.unresolved).toBe(true);
    expect(layout.unresolvedNodeIds).toEqual(["cycle-a", "cycle-b", "downstream"]);
  });

  it("retains one stable node for a duplicate id and reports the duplicate", () => {
    const layout = layoutWorkspaceTaskGraph([taskNode("same", 2), taskNode("same", 1)]);

    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.nodes[0]?.order).toBe(1);
    expect(layout.duplicateNodeIds).toEqual(["same"]);
  });
});
