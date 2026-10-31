import {
  ModelSelection,
  ProviderDriverKind,
  ProviderExecutionId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceAgentExecutionInput } from "./Services/WorkspaceAgentExecutor.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import { workspaceRetryResumeCursor } from "./workspaceSessionResume.ts";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "selected-model",
  options: [{ id: "effort", value: "high" }],
};
const input: WorkspaceAgentExecutionInput = {
  execution: {
    executionId: ProviderExecutionId.make("execution-2"),
    ownerThreadId: ThreadId.make("owner"),
    runId: WorkspaceCollaborationRunId.make("run"),
    nodeId: WorkspaceTaskNodeId.make("node"),
    attempt: 2,
  },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "D:/work",
  prompt: "retry with updated rules",
  title: "Retry",
  displayName: "Codex",
  role: "implementer",
  kind: "implementation",
  startedAt: "2026-10-15T00:00:00Z",
};
const binding: ProviderRuntimeBinding = {
  threadId: ThreadId.make("execution-1"),
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: modelSelection.instanceId,
  runtimeMode: "full-access",
  status: "stopped",
  resumeCursor: { threadId: "native" },
  runtimePayload: {
    cwd: input.cwd,
    modelSelection,
    execution: { ...input.execution, executionId: "execution-1", attempt: 1 },
  },
};
describe("workspace retry resume", () => {
  it("reuses only the immediately preceding native session while keeping execution identities separate", () => {
    expect(workspaceRetryResumeCursor(binding, input)).toEqual({ threadId: "native" });
    for (const provider of ["claudeAgent", "grok", "gemini", "cursor", "opencode"]) {
      expect(
        workspaceRetryResumeCursor(
          { ...binding, provider: ProviderDriverKind.make(provider) },
          input,
        ),
      ).toEqual({ threadId: "native" });
    }
  });
  it("rejects active, other-account, changed-model, changed-policy, other-node and other-work history", () => {
    for (const changed of [
      { ...input, cwd: "D:/other" },
      { ...input, runtimeMode: "auto" as const },
      {
        ...input,
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other") },
      },
      { ...input, modelSelection: { ...modelSelection, model: "different" } },
      {
        ...input,
        modelSelection: { ...modelSelection, options: [{ id: "effort", value: "low" }] },
      },
      { ...input, execution: { ...input.execution, ownerThreadId: ThreadId.make("other") } },
      {
        ...input,
        execution: { ...input.execution, runId: WorkspaceCollaborationRunId.make("other") },
      },
      { ...input, execution: { ...input.execution, nodeId: WorkspaceTaskNodeId.make("other") } },
      { ...input, execution: { ...input.execution, attempt: 3 } },
    ])
      expect(workspaceRetryResumeCursor(binding, changed)).toBeUndefined();
    expect(workspaceRetryResumeCursor({ ...binding, status: "running" }, input)).toBeUndefined();
    expect(
      workspaceRetryResumeCursor(
        { ...binding, provider: ProviderDriverKind.make("unknown") },
        input,
      ),
    ).toBeUndefined();
    expect(workspaceRetryResumeCursor({ ...binding, runtimePayload: {} }, input)).toBeUndefined();
    expect(workspaceRetryResumeCursor(undefined, input)).toBeUndefined();
  });
});
