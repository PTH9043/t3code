import {
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { classifyDashboardTask } from "./taskDashboard.ts";
const now = "2026-10-05T00:00:00Z";
const base = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: ThreadId.make("test"),
  projectId: ProjectId.make("project"),
  title: "Test",
  modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId: TurnId.make("turn"),
    state: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    assistantMessageId: null,
  },
  createdAt: now,
  updatedAt: now,
  session: null,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
it("prioritizes actionable input and live background work over a completed response", () => {
  expect(classifyDashboardTask(base, now)).toBe("completed");
  expect(classifyDashboardTask({ ...base, backgroundLiveness: "working" }, now)).toBe("working");
  expect(
    classifyDashboardTask(
      { ...base, backgroundLiveness: "working", hasPendingUserInput: true },
      now,
    ),
  ).toBe("needs-input");
  expect(classifyDashboardTask({ ...base, hasPendingApprovals: true }, now)).toBe("needs-input");
  expect(classifyDashboardTask({ ...base, backgroundLiveness: "monitoring" }, now)).toBe(
    "monitoring",
  );
  expect(
    classifyDashboardTask({ ...base, latestTurn: { ...base.latestTurn!, state: "error" } }, now),
  ).toBe("failed");
  expect(
    classifyDashboardTask(
      { ...base, latestTurn: { ...base.latestTurn!, state: "interrupted" } },
      now,
    ),
  ).toBe("idle");
});
it("bounds queued starts and does not keep stale sessions falsely working", () => {
  expect(classifyDashboardTask({ ...base, latestTurn: null }, now)).toBe("working");
  expect(
    classifyDashboardTask(
      { ...base, latestTurn: null, latestUserMessageAt: "2026-10-04T00:00:00Z" },
      now,
    ),
  ).toBe("idle");
});
