import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { threadAttentionItems } from "./agentControl.ts";
const at = "2026-10-22T00:00:00Z";
const shell = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  title: "Test",
  modelSelection: { instanceId: ProviderInstanceId.make("provider"), model: "test" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: true,
  hasPendingUserInput: true,
  hasActionableProposedPlan: false,
});
it("keeps approval and question identities separate, scopes environments and removes resolved requests", () => {
  const a = { ...shell, environmentId: EnvironmentId.make("a") };
  const b = { ...shell, environmentId: EnvironmentId.make("b") };
  expect(threadAttentionItems([a, a, b]).map((r) => r.id)).toEqual([
    "a:thread:approval",
    "a:thread:question",
    "b:thread:approval",
    "b:thread:question",
  ]);
  expect(
    threadAttentionItems([{ ...a, hasPendingApprovals: false, hasPendingUserInput: false }]),
  ).toEqual([]);
  expect(threadAttentionItems([{ ...a, archivedAt: at }])).toEqual([]);
});
