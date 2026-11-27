import { describe, expect, it } from "vite-plus/test";
import {
  upcastV1ToV2,
  WorkflowDefinition,
  WorkflowEdgeId,
  WorkflowLoopId,
  WorkflowNodeId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  lintWorkflowGraphV2,
  previewWorkflow,
  validateWorkflowGraphV2Topology,
  workflowDefaults,
} from "./workflow.ts";
const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinition);

describe("workflow authoring", () => {
  it("validates every built-in template and expands values without evaluating them", () => {
    for (const definition of workflowDefaults()) {
      const decoded = decodeDefinition(definition);
      const preview = previewWorkflow(decoded, { goal: "$(do-not-run) `literal`" });
      expect(preview.issues).toEqual([]);
      expect(preview.nodes[0]?.task).toContain("$(do-not-run) `literal`");
    }
    expect(workflowDefaults()).toHaveLength(6);
  });
  it("rejects cycles, missing predecessors and duplicate IDs", () => {
    const definition = workflowDefaults()[0]!;
    expect(
      previewWorkflow(
        {
          ...definition,
          nodes: definition.nodes.map((node, i) => ({
            ...node,
            dependsOn: [i ? "analyze" : "execute"],
          })),
        },
        { goal: "test" },
      ).valid,
    ).toBe(false);
    expect(
      previewWorkflow(
        { ...definition, nodes: [{ ...definition.nodes[0]!, dependsOn: ["missing"] }] },
        { goal: "test" },
      ).valid,
    ).toBe(false);
    expect(
      previewWorkflow(
        { ...definition, nodes: [definition.nodes[0]!, definition.nodes[0]!] },
        { goal: "test" },
      ).valid,
    ).toBe(false);
  });
  it("rejects absent and undeclared inputs and expanded oversized tasks", () => {
    const definition = workflowDefaults()[0]!;
    expect(previewWorkflow(definition, {}).valid).toBe(false);
    expect(previewWorkflow(definition, { goal: "test", unknown: "x" }).valid).toBe(false);
    expect(
      previewWorkflow(
        { ...definition, nodes: [{ ...definition.nodes[0]!, task: "{{unknown}}" }] },
        { goal: "test" },
      ).valid,
    ).toBe(false);
    expect(previewWorkflow(definition, { goal: "x".repeat(4001) }).valid).toBe(false);
  });
  it("validates declared input types and rejects escaping paths", () => {
    const base = workflowDefaults()[0]!;
    const definition = {
      ...base,
      inputs: [
        { name: "goal", label: "경로", type: "path" as const, required: true, defaultValue: "" },
      ],
    };
    for (const goal of [
      "../outside",
      "a/../../outside",
      "C:\\outside",
      "/outside",
      "\\\\server\\share",
    ])
      expect(previewWorkflow(definition, { goal }).valid).toBe(false);
    expect(previewWorkflow(definition, { goal: "apps/web" }).valid).toBe(true);
    expect(
      previewWorkflow(
        { ...definition, inputs: [{ ...definition.inputs[0]!, type: "number" }] },
        { goal: "Infinity" },
      ).valid,
    ).toBe(false);
    expect(
      previewWorkflow(
        { ...definition, inputs: [{ ...definition.inputs[0]!, type: "boolean" }] },
        { goal: "yes" },
      ).valid,
    ).toBe(false);
  });

  it("validates upcasted v2 Forward-DAG topology and permits declared loop_back edges", () => {
    const baseV2 = upcastV1ToV2(workflowDefaults()[0]!);
    const valid = validateWorkflowGraphV2Topology(baseV2);
    expect(valid.valid).toBe(true);
    expect(valid.topologicalOrder).toEqual(["analyze", "execute"]);

    // Adding a declared loop_back edge keeps the Forward-DAG acyclic.
    const withLoop = validateWorkflowGraphV2Topology({
      ...baseV2,
      edges: [
        ...baseV2.edges,
        {
          id: WorkflowEdgeId.make("e_retry"),
          from: WorkflowNodeId.make("execute"),
          to: WorkflowNodeId.make("analyze"),
          kind: "loop_back",
          loopId: WorkflowLoopId.make("loop_1"),
        },
      ],
      loops: [
        {
          loopId: WorkflowLoopId.make("loop_1"),
          entryNodeId: WorkflowNodeId.make("analyze"),
          exitNodeId: WorkflowNodeId.make("execute"),
          maxIterations: 3,
          stagnationDetection: { enabled: true, historyWindowSize: 2 },
          onExhausted: "interrupt_for_human",
        },
      ],
    });
    expect(withLoop.valid).toBe(true);
    expect(withLoop.topologicalOrder).toEqual(["analyze", "execute"]);

    // An undeclared unconditional cycle is rejected.
    const cyclic = validateWorkflowGraphV2Topology({
      ...baseV2,
      edges: [
        ...baseV2.edges,
        {
          id: WorkflowEdgeId.make("e_bad_cycle"),
          from: WorkflowNodeId.make("execute"),
          to: WorkflowNodeId.make("analyze"),
          kind: "unconditional",
        },
      ],
    });
    expect(cyclic.valid).toBe(false);
    expect(cyclic.issues.some((issue) => issue.message.includes("Forward-DAG"))).toBe(true);
  });

  it("lints parallel shared_write conflicts, missing worktree reconcile, and loop guards", () => {
    const parallelRisk = lintWorkflowGraphV2({
      schemaVersion: 2,
      inputs: [],
      nodes: [
        {
          id: WorkflowNodeId.make("a"),
          kind: "agent",
          title: "작업 A",
          joinPolicy: "all_succeeded",
          promptTemplate: "a",
          capability: "code-surgeon",
          isolation: "shared_write",
          sideEffectPolicy: "workspace_mutation",
          inputBindings: {},
          advisoryCriteria: ["기준 A"],
          cleanContext: true,
          cacheable: false,
        },
        {
          id: WorkflowNodeId.make("b"),
          kind: "agent",
          title: "작업 B",
          joinPolicy: "all_succeeded",
          promptTemplate: "b",
          capability: "code-surgeon",
          isolation: "shared_write",
          sideEffectPolicy: "workspace_mutation",
          inputBindings: {},
          advisoryCriteria: [],
          cleanContext: true,
          cacheable: false,
        },
        {
          id: WorkflowNodeId.make("c"),
          kind: "agent",
          title: "격리 작업 C",
          joinPolicy: "all_succeeded",
          promptTemplate: "c",
          capability: "code-surgeon",
          isolation: "git_worktree",
          sideEffectPolicy: "workspace_mutation",
          inputBindings: {},
          advisoryCriteria: [],
          cleanContext: true,
          cacheable: false,
        },
      ],
      edges: [],
      loops: [
        {
          loopId: WorkflowLoopId.make("l1"),
          entryNodeId: WorkflowNodeId.make("a"),
          exitNodeId: WorkflowNodeId.make("a"),
          maxIterations: 3,
          stagnationDetection: { enabled: false, historyWindowSize: 2 },
          onExhausted: "fail_run",
        },
      ],
    });
    expect(parallelRisk.valid).toBe(true);
    expect(parallelRisk.diagnostics.some((d) => d.code === "parallel-shared-write-risk")).toBe(
      true,
    );
    expect(parallelRisk.diagnostics.some((d) => d.code === "worktree-missing-reconcile")).toBe(
      true,
    );
    expect(parallelRisk.diagnostics.some((d) => d.code === "unverified-advisory-criteria")).toBe(
      true,
    );
    expect(parallelRisk.diagnostics.some((d) => d.code === "loop-missing-stagnation-guard")).toBe(
      true,
    );
    expect(parallelRisk.diagnostics.some((d) => d.code === "loop-missing-exit-condition")).toBe(
      true,
    );
  });
});
