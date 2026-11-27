import { describe, expect, it } from "vite-plus/test";
import {
  buildBuiltinWorkflowV2Presets,
  lintWorkflowGraphV2,
  previewWorkflow,
  workflowDefaults,
} from "@t3tools/shared/workflow";
import { type WorkflowVersion } from "@t3tools/contracts";
import { isWorkflowDraftDirty, workflowEditorRevision } from "./workflowEditor";
import { workflowDefinitionFromV2Graph } from "./WorkspaceWorkflowSection";

const definition = workflowDefaults()[0]!;
const saved: WorkflowVersion = {
  ...definition,
  revision: 1,
  digest: "a".repeat(64),
  archived: false,
  createdAt: "2026-10-26T00:00:00.000Z",
};

describe("workflow editor drafts", () => {
  it("imports a definition using its current saved revision", () => {
    expect(workflowEditorRevision(definition, { ...saved, revision: 11 })).toBe(11);
    expect(workflowEditorRevision({ ...definition, title: "Imported edit" }, saved)).toBe(1);
    expect(workflowEditorRevision({ ...definition, id: "new-id" }, saved)).toBe(0);
    expect(workflowEditorRevision(definition, undefined)).toBe(0);
  });
  it("preserves an explicitly loaded version for revision checking", () => {
    expect(workflowEditorRevision({ ...saved, revision: 3 }, { ...saved, revision: 5 })).toBe(3);
  });
  it("compares an input name while the user clears and replaces it", () => {
    const draft = {
      ...definition,
      inputs: definition.inputs.map((input) => ({ ...input, name: "" })),
    };
    expect(() => isWorkflowDraftDirty(draft, saved)).not.toThrow();
    expect(isWorkflowDraftDirty(draft, saved)).toBe(true);
  });
  it("accepts an intermediate empty title, id and task without saving it", () => {
    for (const draft of [
      { ...definition, id: "" },
      { ...definition, title: "" },
      { ...definition, nodes: definition.nodes.map((node) => ({ ...node, task: "" })) },
    ]) {
      expect(() => isWorkflowDraftDirty(draft, saved)).not.toThrow();
      expect(isWorkflowDraftDirty(draft, saved)).toBe(true);
    }
  });
  it("ignores saved version metadata and detects actual content changes", () => {
    expect(isWorkflowDraftDirty(definition, saved)).toBe(false);
    expect(isWorkflowDraftDirty({ ...definition, description: "Changed" }, saved)).toBe(true);
    expect(isWorkflowDraftDirty(definition, undefined)).toBe(true);
    expect(isWorkflowDraftDirty(null, saved)).toBe(false);
  });

  it("exposes 3 valid zero-warning WorkflowGraphV2 presets that convert cleanly to WorkflowDefinition for the UI", () => {
    const presets = buildBuiltinWorkflowV2Presets();
    expect(presets.map((p) => p.id)).toEqual([
      "graph-pr-review",
      "graph-simplify-3way",
      "graph-job-application-drafter-reviewer",
    ]);

    for (const preset of presets) {
      const graph = preset.build();
      const lint = lintWorkflowGraphV2(graph);
      expect(lint.valid).toBe(true);
      expect(lint.errorCount).toBe(0);
      expect(lint.warningCount).toBe(0);

      const converted = workflowDefinitionFromV2Graph(graph);
      expect(converted.id).toBe(preset.id);
      expect(converted.graphV2).toBeDefined();
      const preview = previewWorkflow(converted, {}, { allowMissingRequired: true });
      expect(preview.valid).toBe(true);
    }
  });
});
