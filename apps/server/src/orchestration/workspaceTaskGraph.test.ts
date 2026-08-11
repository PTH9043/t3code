import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildInitialWorkspaceTaskGraph,
  materializeWorkspaceTaskGraphPlan,
  parseWorkspaceSynthesisPayload,
  parseWorkspaceTaskGraphProposal,
  parseWorkspaceValidationDecision,
  readyWorkspaceTaskNodes,
} from "./workspaceTaskGraph.ts";

const taggedPlan = (nodes: ReadonlyArray<Record<string, unknown>>) =>
  `<t3_task_graph>${JSON.stringify({ summary: "계획", nextAction: "실행", nodes })}</t3_task_graph>`;
const node = (input: Partial<Record<string, unknown>> & { id: string }) => ({
  kind: "research",
  agent: "grok",
  title: input.id,
  task: input.id,
  goal: input.id,
  context: "문맥",
  input: "입력",
  constraints: [],
  expectedOutput: "결과",
  successCriteria: ["검증 가능"],
  dependsOn: [],
  priority: 0,
  ...input,
});
const binding = (role: "coordinator" | "researcher" | "implementer") => ({
  projectId: ProjectId.make("workspace-a"),
  role,
  displayName: role,
  modelSelection: {
    instanceId: ProviderInstanceId.make(
      role === "coordinator" ? "claude" : role === "researcher" ? "grok" : "codex",
    ),
    model: "model",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  instructions: "",
  enabled: true,
  updatedAt: "2026-08-09T00:00:00.000Z",
});

describe("Workspace task graph", () => {
  it("rejects duplicate, missing, cyclic, and incompatible routes", () => {
    expect(() =>
      parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "same" }), node({ id: "same" })])),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "a", dependsOn: ["missing"] })])),
    ).toThrow(/missing/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(
        taggedPlan([node({ id: "a", dependsOn: ["b"] }), node({ id: "b", dependsOn: ["a"] })]),
      ),
    ).toThrow(/cycle/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(
        taggedPlan([node({ id: "build", kind: "implementation", agent: "grok" })]),
      ),
    ).toThrow(/codex/);
  });

  it("inserts Fable validation gates and keeps independent work in one ready wave", () => {
    const initial = buildInitialWorkspaceTaskGraph("기능 구현");
    const planned = {
      ...initial,
      nodes: initial.nodes.map((item) => ({
        ...item,
        status: "completed" as const,
        output: "계획",
      })),
    };
    const proposal = parseWorkspaceTaskGraphProposal(
      taggedPlan([
        node({ id: "research" }),
        node({ id: "build", kind: "implementation", agent: "codex" }),
      ]),
    );
    const graph = materializeWorkspaceTaskGraphPlan({
      graph: planned,
      proposal,
      bindings: [binding("coordinator"), binding("researcher"), binding("implementer")],
      occurredAt: "2026-08-09T00:00:00.000Z",
    });
    expect(readyWorkspaceTaskNodes(graph).map((item) => item.id)).toEqual(["research", "build"]);
    expect(graph.nodes.filter((item) => item.kind === "validation")).toHaveLength(2);
    expect(graph.nodes.find((item) => item.kind === "synthesis")?.dependsOn).toEqual([
      "validate-research",
      "validate-build",
    ]);
  });

  it("opens validation only after its producer awaits validation", () => {
    const initial = buildInitialWorkspaceTaskGraph("조사");
    const planned = {
      ...initial,
      nodes: initial.nodes.map((item) => ({
        ...item,
        status: "completed" as const,
        output: "계획",
      })),
    };
    const graph = materializeWorkspaceTaskGraphPlan({
      graph: planned,
      proposal: parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "research" })])),
      bindings: [binding("coordinator"), binding("researcher")],
      occurredAt: "2026-08-09T00:00:00.000Z",
    });
    const afterResearch = {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "research" ? { ...item, status: "awaiting-validation" as const } : item,
      ),
    };
    expect(readyWorkspaceTaskNodes(afterResearch).map((item) => item.id)).toEqual([
      "validate-research",
    ]);
  });

  it("parses low-confidence validation and bounded synthesis memory", () => {
    const validation = parseWorkspaceValidationDecision(
      `<t3_validation>${JSON.stringify({ verdict: "inconclusive", confidence: "low", summary: "근거 부족", evidence: [], failureClassification: "information", nextAction: "추가 조사", followUpNodes: [] })}</t3_validation>`,
    );
    expect(validation).toMatchObject({ confidence: "low", failureClassification: "information" });
    expect(() =>
      parseWorkspaceValidationDecision(
        `<t3_validation>${JSON.stringify({ verdict: "fail", confidence: "high", summary: "순환", evidence: [], failureClassification: "implementation", nextAction: "수정", followUpNodes: [node({ id: "debug-a", kind: "debug", agent: "codex", dependsOn: ["debug-b"] }), node({ id: "debug-b", kind: "debug", agent: "codex", dependsOn: ["debug-a"] })] })}</t3_validation>`,
      ),
    ).toThrow(/cycle/);
    const synthesis = parseWorkspaceSynthesisPayload(
      `<t3_synthesis>${JSON.stringify({ finalOutput: "완료", confidence: "high", conflictDetected: false, nextAction: "완료", repairApproved: null, memoryCandidates: [{ category: "architecture", title: "구조", content: "검증된 구조", tags: ["verified"], confidence: "high", sourceNodeIds: ["research"] }] })}</t3_synthesis>`,
    );
    expect(synthesis.memoryCandidates).toHaveLength(1);
    expect(synthesis.confidence).toBe("high");
    expect(synthesis).toMatchObject({ conflictDetected: false, nextAction: "완료" });
  });
});
