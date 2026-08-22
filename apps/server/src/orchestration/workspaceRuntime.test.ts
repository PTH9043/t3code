import {
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceScheduleId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { deriveWorkspaceRuntimeSnapshot } from "./workspaceRuntime.ts";

const projectId = ProjectId.make("runtime-project");
const at = "2026-08-10T00:00:00.000Z";

function thread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-runtime"),
      model: "gpt-5",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "running",
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: at,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function derive(threads: ReadonlyArray<OrchestrationThreadShell>) {
  return deriveWorkspaceRuntimeSnapshot({
    projectId,
    projectUpdatedAt: at,
    projectRuntimeViewedThrough: null,
    threads,
    programs: [],
    programRuns: [],
    incidents: [],
    collaborationRuns: [],
    schedules: [],
    monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
    now: at,
  });
}

it("marks a project blocked when a running turn needs human approval", () => {
  const snapshot = derive([thread("waiting", { hasPendingApprovals: true })]);

  expect(snapshot.status).toBe("blocked");
  expect(snapshot.lifecycleStatus).toBe("idle");
  expect(snapshot.attention).toBe("needs-input");
  expect(snapshot.counts.blockedThreadCount).toBe(1);
  expect(snapshot.counts.workingThreadCount).toBe(0);
  expect(snapshot.evidence[0]).toMatchObject({
    source: "thread",
    status: "blocked",
    sourceId: "waiting",
  });
});

it("keeps failure evidence above blocked and working evidence", () => {
  const snapshot = derive([
    thread("working"),
    thread("blocked", { hasPendingUserInput: true }),
    thread("failed", {
      latestTurn: {
        turnId: TurnId.make("turn-failed"),
        state: "error",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        assistantMessageId: null,
      },
    }),
  ]);

  expect(snapshot.status).toBe("failed");
  expect(snapshot.lifecycleStatus).toBe("failed");
  expect(snapshot.attention).toBe("error");
  expect(snapshot.evidence.map((item) => item.status)).toEqual(["failed", "blocked", "working"]);
  expect(snapshot.counts.attentionCount).toBe(2);
});

it("reports an empty registered project as idle", () => {
  const snapshot = derive([]);

  expect(snapshot.status).toBe("idle");
  expect(snapshot.lifecycleStatus).toBe("idle");
  expect(snapshot.attention).toBe("none");
  expect(snapshot.evidence).toEqual([]);
  expect(snapshot.operationsUpdatedAt).toBeNull();
  expect(snapshot.updatedAt).toBe(at);
});

it("separates operation changes from conversation activity", () => {
  const operationAt = "2026-08-10T00:02:00.000Z";
  const snapshot = deriveWorkspaceRuntimeSnapshot({
    projectId,
    projectUpdatedAt: at,
    projectRuntimeViewedThrough: null,
    threads: [thread("newer-thread", { updatedAt: "2026-08-10T00:03:00.000Z" })],
    programs: [],
    programRuns: [],
    incidents: [],
    collaborationRuns: [],
    schedules: [
      {
        id: WorkspaceScheduleId.make("schedule-runtime"),
        projectId,
        title: "매일 점검",
        task: "상태 점검",
        enabled: true,
        timing: { kind: "interval", everyMinutes: 60, startAt: at },
        nextTriggerAt: null,
        lastTriggeredAt: null,
        lastRunId: null,
        lastError: null,
        createdAt: at,
        updatedAt: operationAt,
      },
    ],
    monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
    now: at,
  });

  expect(snapshot.updatedAt).toBe("2026-08-10T00:03:00.000Z");
  expect(snapshot.operationsUpdatedAt).toBe(operationAt);
});

it("keeps completed work visible until the project has been viewed", () => {
  const completedAt = "2026-08-10T00:01:00.000Z";
  const completed = thread("completed", {
    latestTurn: {
      turnId: TurnId.make("turn-completed"),
      state: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt,
      assistantMessageId: null,
    },
    updatedAt: completedAt,
  });

  const unseen = deriveWorkspaceRuntimeSnapshot({
    projectId,
    projectUpdatedAt: at,
    projectRuntimeViewedThrough: null,
    threads: [completed],
    programs: [],
    programRuns: [],
    incidents: [],
    collaborationRuns: [],
    schedules: [],
    monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
    now: at,
  });
  const seen = deriveWorkspaceRuntimeSnapshot({
    projectId,
    projectUpdatedAt: at,
    projectRuntimeViewedThrough: completedAt,
    threads: [completed],
    programs: [],
    programRuns: [],
    incidents: [],
    collaborationRuns: [],
    schedules: [],
    monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
    now: at,
  });

  expect(unseen.attention).toBe("completed-unseen");
  expect(unseen.counts.completedUnseenCount).toBe(1);
  expect(unseen.latestCompletionAt).toBe(completedAt);
  expect(seen.attention).toBe("none");
  expect(seen.counts.completedUnseenCount).toBe(0);
});
