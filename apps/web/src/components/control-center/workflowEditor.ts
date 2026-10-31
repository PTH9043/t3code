import { WorkflowDefinition, type WorkflowVersion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const equivalentDefinition = Schema.toEquivalence(WorkflowDefinition);

export function isWorkflowDraftDirty(
  draft: WorkflowDefinition | null,
  saved: WorkflowVersion | undefined,
): boolean {
  return !!draft && (!saved || !equivalentDefinition(saved, draft));
}

export function workflowEditorRevision(
  definition: WorkflowDefinition | WorkflowVersion,
  saved: WorkflowVersion | undefined,
): number {
  return "revision" in definition
    ? definition.revision
    : saved?.id === definition.id
      ? saved.revision
      : 0;
}
