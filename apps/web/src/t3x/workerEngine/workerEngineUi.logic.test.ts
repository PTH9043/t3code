import type {
  WorkerDispatchRecord,
  WorkerMailboxMessageRecord,
  WorkerStatusResult,
  WorkerTaskRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseWorkerEngineResponse, WorkerEngineClientError } from "./workerEngineClient";
import {
  buildMailboxAckPlan,
  classifyDiffPatch,
  computeWorkerEngineCounts,
  describeHeartbeatAge,
  isWorktreeReviewable,
  sortWorkerTasksForBoard,
} from "./workerEngineUi.logic";

function makeTask(overrides: Partial<WorkerTaskRecord> = {}): WorkerTaskRecord {
  return {
    taskId: "task_1",
    runId: "run_1",
    threadId: "thread_1",
    ownerTurnId: null,
    callerKind: "t3_supervisor",
    dedupKey: "dedup_1",
    idempotencyKey: null,
    role: "coder",
    targetInstanceId: "codex",
    targetModel: "gpt-5.4",
    specText: "Implement worker UI",
    ragFactsJson: null,
    status: "dispatched",
    activeDispatchId: "disp_1",
    fencingEpoch: 1,
    failureCount: 0,
    worktreeMode: "isolated",
    worktreePath: "D:/repo/.worktrees/worker-1",
    worktreeBranch: "t3code/worker-task_1",
    worktreeBaseRef: "main",
    worktreeState: "active",
    cwd: "D:/repo",
    outcome: null,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    finishedAtMs: null,
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<WorkerDispatchRecord> = {}): WorkerDispatchRecord {
  return {
    dispatchId: "disp_1",
    taskId: "task_1",
    runId: "run_1",
    threadId: "thread_1",
    attempt: 1,
    fencingToken: 1,
    retryOfDispatchId: null,
    executionId: null,
    providerInstanceId: "codex",
    model: "gpt-5.4",
    role: "coder",
    status: "running",
    lastHeartbeatAtMs: 1_000,
    heartbeatTimeoutMs: 300_000,
    lastToolSummary: "read_file",
    resultText: null,
    errorMessage: null,
    startedAtMs: 1_000,
    finishedAtMs: null,
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<WorkerMailboxMessageRecord> = {},
): WorkerMailboxMessageRecord {
  return {
    sequence: 1,
    messageId: "msg_1",
    runId: "run_1",
    threadId: "thread_1",
    taskId: "task_1",
    dispatchId: "disp_1",
    fencingToken: 1,
    fromActor: "worker:task_1",
    toActor: "supervisor",
    type: "worker_done",
    outcome: "succeeded",
    subject: "완료",
    body: "작업이 끝났습니다.",
    payloadJson: null,
    deliveryId: null,
    createdAtMs: 1_000,
    deliveredAtMs: null,
    acknowledgedAtMs: null,
    ...overrides,
  };
}

describe("workerEngineUi.logic", () => {
  it("computes attention and status summary counts accurately", () => {
    const status: WorkerStatusResult = {
      tasks: [
        makeTask({ taskId: "t1", status: "dispatched", worktreeState: "active" }),
        makeTask({ taskId: "t2", status: "blocked", worktreeState: "none" }),
        makeTask({ taskId: "t3", status: "completed", worktreeState: "review_ready" }),
      ],
      activeDispatches: [makeDispatch({ dispatchId: "d1", taskId: "t1", status: "stalled" })],
      openGates: [
        {
          gateId: "gate_1",
          taskId: "t2",
          dispatchId: null,
          threadId: "thread_1",
          riskLevel: "high",
          question: "프로덕션 배포를 진행할까요?",
          options: ["approve", "deny"],
          status: "open",
          resolution: null,
          resolvedBy: null,
          createdAtMs: 1_000,
          resolvedAtMs: null,
        },
      ],
      unreadMailboxCount: 4,
    };

    expect(computeWorkerEngineCounts(status)).toEqual({
      totalTasks: 3,
      activeCount: 1,
      stalledCount: 1,
      blockedCount: 1,
      reviewReadyCount: 1,
      openGateCount: 1,
      unreadMailboxCount: 4,
      attentionCount: 3,
    });
  });

  it("sorts stalled, blocked, running, review_ready, and completed tasks by priority", () => {
    const tasks = [
      makeTask({
        taskId: "completed",
        status: "completed",
        worktreeState: "merged",
        updatedAtMs: 9_000,
      }),
      makeTask({
        taskId: "review",
        status: "completed",
        worktreeState: "review_ready",
        updatedAtMs: 5_000,
      }),
      makeTask({
        taskId: "running",
        status: "dispatched",
        worktreeState: "active",
        updatedAtMs: 4_000,
      }),
      makeTask({ taskId: "blocked", status: "blocked", worktreeState: "none", updatedAtMs: 3_000 }),
      makeTask({
        taskId: "stalled",
        status: "dispatched",
        worktreeState: "active",
        updatedAtMs: 2_000,
      }),
    ];
    const activeDispatches = [
      makeDispatch({ dispatchId: "d_run", taskId: "running", status: "running" }),
      makeDispatch({ dispatchId: "d_stall", taskId: "stalled", status: "stalled" }),
    ];

    const sorted = sortWorkerTasksForBoard(tasks, activeDispatches);
    expect(sorted.map((t) => t.taskId)).toEqual([
      "stalled",
      "blocked",
      "running",
      "review",
      "completed",
    ]);
  });

  it("describes heartbeat silence across ok, warning (5m), and danger (15m) tiers", () => {
    expect(describeHeartbeatAge(10_000, 12_000).severity).toBe("ok");
    expect(describeHeartbeatAge(10_000, 10_000 + 305_000)).toMatchObject({
      severity: "warning",
    });
    expect(describeHeartbeatAge(10_000, 10_000 + 910_000)).toMatchObject({
      severity: "danger",
    });
  });

  it("classifies unified diff lines and respects maxLines truncation", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      " export default a;",
    ].join("\n");

    const result = classifyDiffPatch(patch, 5);
    expect(result.truncated).toBe(true);
    expect(result.totalLineCount).toBe(7);
    expect(result.lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "removed"]);
  });

  it("builds mailbox ACK plan distinguishing existing deliveries from unclaimed messages", () => {
    const plan = buildMailboxAckPlan([
      makeMessage({ messageId: "m1", deliveryId: "del_1" }),
      makeMessage({ messageId: "m2", deliveryId: "del_1" }),
      makeMessage({ messageId: "m3", deliveryId: null }),
      makeMessage({ messageId: "m4", deliveryId: "del_old", acknowledgedAtMs: 5_000 }),
    ]);
    expect(plan).toEqual({
      existingDeliveryIds: ["del_1"],
      hasUnclaimedMessages: true,
    });
  });

  it("detects reviewable isolated worktrees only", () => {
    expect(
      isWorktreeReviewable(makeTask({ worktreeMode: "isolated", worktreeState: "review_ready" })),
    ).toBe(true);
    expect(
      isWorktreeReviewable(makeTask({ worktreeMode: "isolated", worktreeState: "merged" })),
    ).toBe(false);
    expect(
      isWorktreeReviewable(
        makeTask({ worktreeMode: "current", worktreeState: "none", worktreePath: null }),
      ),
    ).toBe(false);
  });

  it("parses WorkerEngine HTTP envelopes and surfaces structured errors", async () => {
    const okRes = new Response(JSON.stringify({ ok: true, result: { tasks: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(parseWorkerEngineResponse<{ tasks: unknown[] }>(okRes)).resolves.toEqual({
      tasks: [],
    });

    const errRes = new Response(
      JSON.stringify({ ok: false, error: { code: "concurrency_limit", message: "limit reached" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
    await expect(parseWorkerEngineResponse(errRes)).rejects.toMatchObject({
      name: "WorkerEngineClientError",
      code: "concurrency_limit",
      status: 429,
      message: "limit reached",
    } satisfies Partial<WorkerEngineClientError>);
  });
});
