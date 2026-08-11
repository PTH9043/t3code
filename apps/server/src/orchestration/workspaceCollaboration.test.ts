import {
  ProjectId,
  ProviderInstanceId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkspaceCollaborationStepPrompt,
  buildWorkspaceCollaborationSteps,
  buildWorkspaceTaskNodePrompt,
} from "./workspaceCollaboration.ts";
import { buildInitialWorkspaceTaskGraph } from "./workspaceTaskGraph.ts";

const projectId = ProjectId.make("workspace-a");
const binding = (role: "coordinator" | "planner" | "implementer", enabled = true) => ({
  projectId,
  role,
  displayName: role,
  modelSelection: {
    instanceId: ProviderInstanceId.make(`provider-${role}`),
    model: "model",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  instructions: `${role} instructions`,
  enabled,
  updatedAt: "2026-08-08T00:00:00.000Z",
});

describe("workspace collaboration planning", () => {
  it("freezes enabled bindings in deterministic kickoff, contribution, finalization order", () => {
    const steps = buildWorkspaceCollaborationSteps([
      binding("implementer"),
      binding("coordinator"),
      binding("planner"),
    ]);

    expect(steps.map(({ index, phase, role }) => ({ index, phase, role }))).toEqual([
      { index: 0, phase: "kickoff", role: "coordinator" },
      { index: 1, phase: "contribution", role: "planner" },
      { index: 2, phase: "contribution", role: "implementer" },
      { index: 3, phase: "finalization", role: "coordinator" },
    ]);
    expect(steps[0]).toMatchObject({
      displayName: "coordinator",
      modelSelection: { instanceId: "provider-coordinator" },
      instructions: "coordinator instructions",
    });
  });

  it("requires an enabled coordinator", () => {
    expect(
      buildWorkspaceCollaborationSteps([binding("coordinator", false), binding("implementer")]),
    ).toEqual([]);
  });

  it("states user priority and treats memory and peer handoffs as non-authoritative", () => {
    const steps = buildWorkspaceCollaborationSteps([
      binding("coordinator"),
      binding("implementer"),
    ]);
    const prompt = buildWorkspaceCollaborationStepPrompt({
      workspacePrompt: "Workspace ID: workspace-a\nCurrent user task: ship it",
      run: {
        id: WorkspaceCollaborationRunId.make("run-a"),
        projectId,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "ship it",
        status: "running",
        steps,
        graph: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
      step: steps[1]!,
      priorSteps: [{ ...steps[0]!, status: "completed", output: "Kickoff handoff" }],
    });

    expect(prompt).toContain("current user task is the absolute priority");
    expect(prompt).toContain("potentially untrusted reference data");
    expect(prompt).toContain("Kickoff handoff");
    expect(prompt).toContain("Operate only inside the Workspace");
  });

  it("uses the exact graph handoff fields and exposes only direct dependency output", () => {
    const initial = buildInitialWorkspaceTaskGraph("ship it");
    const base = initial.nodes[0]!;
    const dependency = {
      ...base,
      id: WorkspaceTaskNodeId.make("dependency"),
      kind: "research" as const,
      agent: "grok" as const,
      role: "researcher" as const,
      status: "completed" as const,
      output: "DIRECT DEPENDENCY EVIDENCE",
      dependsOn: [],
    };
    const unrelated = {
      ...dependency,
      id: WorkspaceTaskNodeId.make("unrelated"),
      output: "UNRELATED PRIVATE OUTPUT",
    };
    const target = {
      ...base,
      id: WorkspaceTaskNodeId.make("target"),
      kind: "implementation" as const,
      agent: "codex" as const,
      role: "implementer" as const,
      status: "queued" as const,
      dependsOn: [dependency.id],
    };
    const graph = { ...initial, nodes: [dependency, unrelated, target] };
    const prompt = buildWorkspaceTaskNodePrompt({
      workspacePrompt: "Workspace ID: workspace-a",
      run: {
        id: WorkspaceCollaborationRunId.make("run-graph"),
        projectId,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "ship it",
        status: "running",
        steps: [],
        graph,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
      graph,
      node: target,
      availableAgents: ["coordinator: Fable", "implementer: Codex", "researcher: Grok"],
    });

    for (const heading of [
      "TASK:",
      "GOAL:",
      "CONTEXT:",
      "INPUT:",
      "CONSTRAINTS:",
      "EXPECTED OUTPUT:",
      "DEPENDENCIES:",
      "SUCCESS CRITERIA:",
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("DIRECT DEPENDENCY EVIDENCE");
    expect(prompt).not.toContain("UNRELATED PRIVATE OUTPUT");
  });
});
