import { describe, expect, it } from "vitest";
import { WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { previewWorkflow, workflowDefaults } from "./workflow.ts";
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
});
