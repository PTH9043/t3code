import {
  CommandId,
  DevelopmentBindingId,
  DevelopmentWorkspaceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type DevelopmentTask,
  type DevelopmentVerification,
  type DevelopmentWorkspace,
  type WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  developmentDispatchBarrier,
  developmentTaskMayRun,
  developmentVerificationBarrier,
  sameDevelopmentModel,
  supersedeDevelopmentTasks,
} from "./workspaceDevelopmentPolicy.ts";

export const workspace: DevelopmentWorkspace = {
  id: DevelopmentWorkspaceId.make("inventory"),
  name: "Inventory",
  scope: ["inventory"],
  bindingId: DevelopmentBindingId.make("binding"),
  worktreePath: "D:/한글 작업실",
  branch: "workspace/inventory",
  baseSha: "a".repeat(40),
  observedFingerprint: "initial",
  generation: 1,
  definitionRevision: 1,
  stateRevision: 3,
  requirementRevision: 1,
  control: "managed",
  takeover: false,
  externalUnmanaged: false,
  summaryPending: false,
  status: "ready",
  error: null,
  lastSummary: "",
};
export const state: WorkspaceDevelopmentState = {
  projectId: ProjectId.make("project"),
  conversationId: ThreadId.make("main"),
  enabled: true,
  policyRevision: 1,
  revision: 3,
  mainObservedRevision: 3,
  mainActedRevision: 0,
  pendingMainNotification: false,
  ownerModels: [{ instanceId: ProviderInstanceId.make("codex"), model: "selected" }],
  runtimeMode: "approval-required",
  maxParallelOwners: 3,
  verificationCommands: [{ command: "node", args: ["--test"] }],
  bindings: [],
  workspaces: [workspace],
  tasks: [],
  verifications: [],
  integrations: [],
};
export const task: DevelopmentTask = {
  id: "T-1",
  commandId: CommandId.make("dispatch"),
  workspaceId: workspace.id,
  bindingId: workspace.bindingId,
  source: "main-dispatch",
  objective: "implement",
  acceptanceCriteria: ["tests"],
  requirementRevision: 1,
  mode: "queue",
  status: "queued",
  runId: "run1",
  fencingGeneration: 0,
  delivery: "pending",
  nativeTurnId: null,
  nativeMessageIds: [],
  messageId: "original",
  baseSha: workspace.baseSha,
  candidateSha: null,
  output: "",
  error: null,
  requestedAt: "2026-09-30T00:00:00Z",
  completedAt: null,
};
const verification: DevelopmentVerification = {
  id: "V-A",
  workspaceId: workspace.id,
  candidateSha: workspace.baseSha,
  requirementRevision: 1,
  generation: 1,
  targetSha: "b".repeat(40),
  commands: [],
  status: "passed",
  verifiedAt: task.requestedAt,
};

describe("persistent workspace control", () => {
  it("keeps observed and acted cursors separate", () => {
    expect(developmentDispatchBarrier(state, workspace)).toBeNull();
    expect(state.mainActedRevision).toBe(0);
    expect(
      developmentDispatchBarrier({ ...state, mainObservedRevision: 2 }, workspace),
    ).toBeTruthy();
  });
  for (const control of ["human", "reconciling"] as const)
    it(`blocks Main dispatch during ${control} control`, () => {
      expect(developmentDispatchBarrier(state, { ...workspace, control })).toBeTruthy();
      expect(developmentTaskMayRun({ ...workspace, control }, task)).toBe(false);
      expect(
        developmentTaskMayRun({ ...workspace, control }, { ...task, source: "user-direct" }),
      ).toBe(true);
    });
  it("blocks external and unsummarized changes", () => {
    expect(developmentDispatchBarrier(state, { ...workspace, summaryPending: true })).toBeTruthy();
    expect(
      developmentDispatchBarrier(state, { ...workspace, externalUnmanaged: true }),
    ).toBeTruthy();
    expect(
      developmentTaskMayRun(
        { ...workspace, externalUnmanaged: true },
        { ...task, source: "user-direct" },
      ),
    ).toBe(false);
  });
  it("does not replay unknown input receipt", () => {
    expect(developmentTaskMayRun(workspace, { ...task, delivery: "delivery_unknown" })).toBe(false);
  });
  it("supersedes prior Main intent without completing the work", () => {
    const result = supersedeDevelopmentTasks(
      [task, { ...task, id: "human", source: "user-direct" }],
      workspace.id,
    );
    expect(result.map((task) => task.status)).toEqual(["superseded", "queued"]);
    expect(developmentTaskMayRun({ ...workspace, requirementRevision: 2 }, task)).toBe(false);
  });
  it("allows an explicit user replacement to retire uncertain Main intent while preserving the receipt", () => {
    const unknown = {
      ...task,
      status: "delivery_unknown" as const,
      delivery: "delivery_unknown" as const,
    };
    const failed = { ...unknown, id: "legacy-failed", status: "failed" as const };
    const result = supersedeDevelopmentTasks(
      [unknown, failed, { ...unknown, id: "user", source: "user-direct" }],
      workspace.id,
    );
    expect(result.map((entry) => entry.status)).toEqual([
      "superseded",
      "superseded",
      "delivery_unknown",
    ]);
    expect(result[0]?.messageId).toBe(unknown.messageId);
    expect(result[0]?.delivery).toBe("delivery_unknown");
  });
  it("never treats A approval as approval of B", () => {
    expect(developmentVerificationBarrier(workspace, verification, "c".repeat(40))).toBeTruthy();
    expect(developmentVerificationBarrier(workspace, verification, workspace.baseSha)).toBeNull();
  });
  it("invalidates completion after requirement or worktree generation changes", () => {
    expect(
      developmentVerificationBarrier(
        { ...workspace, requirementRevision: 2 },
        verification,
        workspace.baseSha,
      ),
    ).toBeTruthy();
    expect(
      developmentVerificationBarrier(
        { ...workspace, generation: 2 },
        verification,
        workspace.baseSha,
      ),
    ).toBeTruthy();
  });
  it("includes provider namespace and options in the approved profile", () => {
    const model = state.ownerModels[0]!;
    expect(sameDevelopmentModel(model, model)).toBe(true);
    expect(
      sameDevelopmentModel(model, { ...model, instanceId: ProviderInstanceId.make("other") }),
    ).toBe(false);
    expect(
      sameDevelopmentModel(model, {
        ...model,
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBe(false);
  });
});
