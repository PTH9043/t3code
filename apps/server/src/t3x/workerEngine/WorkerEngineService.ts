// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import {
  ProviderExecutionId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  type WorkerAckInput,
  type WorkerAckResult,
  type WorkerCheckInput,
  type WorkerCheckResult,
  type WorkerDecisionGateRecord,
  type WorkerDecisionGateStatus,
  type WorkerDispatchInput,
  type WorkerDispatchReceipt,
  type WorkerDispatchRecord,
  type WorkerGateCreateInput,
  type WorkerGateResolveInput,
  type WorkerMailboxMessageRecord,
  type WorkerOutcome,
  type WorkerStatusResult,
  type WorkerStopInput,
  type WorkerStopResult,
  type WorkerTaskRecord,
  type WorkerWorktreeActionResult,
  type WorkerWorktreeDiffResult,
  type WorkerWorktreeMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAgentExecutor } from "../../orchestration/Services/WorkspaceAgentExecutor.ts";
import {
  getUnavailableModelReason,
  recordUnavailableModelFromError,
} from "../../provider/workerFailurePolicy.ts";
import {
  annotateExecutionSpan,
  unifiedExecutionLedger,
} from "../executionLedger/UnifiedExecutionLedger.ts";
import { makeWorkerDecisionGateService } from "./WorkerDecisionGateService.ts";
import { WorkerEngineError, makeWorkerEngineStore } from "./WorkerEngineStore.ts";
import {
  makeWorkerHeartbeatMonitor,
  type WorkerHeartbeatMonitorOptions,
} from "./WorkerHeartbeatMonitor.ts";
import { makeWorkerMailboxService, type PostMailboxMessageInput } from "./WorkerMailboxService.ts";
import { makeWorkerWorktreeLifecycle } from "./WorkerWorktreeLifecycle.ts";

export interface WorkerExecutionRequest {
  readonly task: WorkerTaskRecord;
  readonly dispatch: WorkerDispatchRecord;
  readonly effectiveCwd: string;
  readonly onActivity: (toolSummary?: string | null) => Effect.Effect<void>;
  readonly onPartialOutput?: (fullOutput: string) => void;
}

export interface WorkerExecutionOutput {
  readonly resultText: string;
  readonly summary?: string | undefined;
  readonly filesModified?: ReadonlyArray<string> | undefined;
  readonly exitCode?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
}

export type WorkerExecutionRunner = (
  request: WorkerExecutionRequest,
) => Effect.Effect<WorkerExecutionOutput, WorkerEngineError>;

export interface WorkerDispatchOptions {
  /** Custom execution runner (used by Strangler Fig callers: delegate, council, orchestra). */
  readonly runner?: WorkerExecutionRunner | undefined;
  /** Allow spawning even when an identical task is already active in the thread. */
  readonly allowDuplicate?: boolean | undefined;
  /** Caller-specified dispatch ID (e.g. `delegationId` for 1:1 correlation). */
  readonly dispatchId?: string | undefined;
  /** Override per-thread active worker ceiling for callers that enforce their own wave width. */
  readonly maxRunningPerThread?: number | undefined;
  /** Skip recording to `UnifiedExecutionLedger` when the caller manages its own ledger entries. */
  readonly skipLedger?: boolean | undefined;
  /** Record an externally provisioned worktree on `worker_tasks` without re-creating it. */
  readonly externalWorktree?:
    | {
        readonly worktreePath: string;
        readonly worktreeBranch: string | null;
      }
    | undefined;
}

export interface WorkerRunAndCollectResult {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly runId: string;
  readonly resultText: string;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
}

const WRITE_ROLES = new Set(["worker", "writer", "implementer", "coder"]);

function resolveDefaultWorktreeMode(
  role: string,
  explicit?: WorkerWorktreeMode,
): WorkerWorktreeMode {
  if (explicit) return explicit;
  return WRITE_ROLES.has(role.trim().toLowerCase()) ? "isolated" : "current";
}

function summarizeRuntimeEvent(event: ProviderRuntimeEvent): string | null {
  if (event.type === "item.started" || event.type === "item.updated") {
    const payload = event.payload as
      | { readonly title?: unknown; readonly itemType?: unknown }
      | undefined;
    if (typeof payload?.title === "string" && payload.title.trim().length > 0) {
      return payload.title.trim().slice(0, 120);
    }
    if (typeof payload?.itemType === "string") {
      return payload.itemType;
    }
  }
  return null;
}

function makeDefaultExecutorRunner(
  executorOpt: Option.Option<WorkspaceAgentExecutor["Service"]>,
  projectionSnapshotQueryOpt: Option.Option<ProjectionSnapshotQuery["Service"]>,
): WorkerExecutionRunner {
  return (request) =>
    Effect.gen(function* () {
      if (Option.isNone(executorOpt)) {
        return yield* new WorkerEngineError({
          code: "invalid_state",
          message: "WorkspaceAgentExecutor is not configured in this WorkerEngineService runtime.",
        });
      }
      const executor = executorOpt.value;
      const isWriteRole = WRITE_ROLES.has(request.task.role.trim().toLowerCase());
      const model = request.dispatch.model?.trim() || "default";
      const promptWithFacts = request.task.ragFactsJson
        ? `${request.task.specText}\n\n## 참고 사실\n${request.task.ragFactsJson}`
        : request.task.specText;
      const ownerThreadId = ThreadId.make(request.task.threadId);

      // 소유 채팅방의 runtimeMode / interactionMode를 있는 그대로 상속한다.
      // 역할(reviewer/planner 등)을 이유로 full-access 채팅방을 approval-required/plan으로 격하하지 않는다.
      const resolvedModes: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      } = Option.isSome(projectionSnapshotQueryOpt)
        ? yield* projectionSnapshotQueryOpt.value.getThreadRuntimeContext(ownerThreadId).pipe(
            Effect.map((opt) =>
              Option.isSome(opt)
                ? {
                    runtimeMode: opt.value.runtimeMode,
                    interactionMode: opt.value.interactionMode,
                  }
                : {
                    runtimeMode: "approval-required" as const,
                    interactionMode: "default" as const,
                  },
            ),
            Effect.catchCause(() =>
              Effect.succeed({
                runtimeMode: "approval-required" as const,
                interactionMode: "default" as const,
              }),
            ),
          )
        : {
            runtimeMode: isWriteRole ? "full-access" : "approval-required",
            interactionMode: "default",
          };

      const outputText = yield* executor
        .execute({
          usageWorkId: `worker:${request.dispatch.dispatchId}`,
          execution: {
            executionId: ProviderExecutionId.make(request.dispatch.dispatchId),
            ownerThreadId,
            runId: WorkspaceCollaborationRunId.make(request.task.runId),
            nodeId: WorkspaceTaskNodeId.make(
              request.task.taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64),
            ),
            attempt: request.dispatch.attempt,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make(request.dispatch.providerInstanceId),
            model,
          },
          runtimeMode: resolvedModes.runtimeMode,
          interactionMode: resolvedModes.interactionMode,
          cwd: request.effectiveCwd,
          prompt: promptWithFacts,
          title: `T3 작업자 (${request.task.role}) · ${request.task.taskId}`,
          displayName: `${request.dispatch.providerInstanceId}/${model}`,
          role: isWriteRole ? "implementer" : "reviewer",
          kind: isWriteRole ? "implementation" : "validation",
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(request.dispatch.startedAtMs)),
          onRuntimeEvent: (event) =>
            request.onActivity(summarizeRuntimeEvent(event)).pipe(Effect.ignore),
          ...(request.onPartialOutput ? { onPartialOutput: request.onPartialOutput } : {}),
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new WorkerEngineError({
                code: "invalid_state",
                message: err.message,
                details: {
                  ...(err.interrupted !== undefined ? { interrupted: err.interrupted } : {}),
                  ...(err.timedOut !== undefined ? { timedOut: err.timedOut } : {}),
                  ...(err.partialOutput ? { partialOutput: err.partialOutput } : {}),
                  ...(err.nonRetryable ? { nonRetryable: true } : {}),
                },
              }),
          ),
        );

      return {
        resultText: outputText,
        summary: outputText.slice(0, 400),
        exitCode: 0,
      };
    });
}

export interface WorkerEngineServiceShape {
  readonly dispatch: (
    input: WorkerDispatchInput,
  ) => Effect.Effect<WorkerDispatchReceipt, WorkerEngineError>;
  readonly dispatchWithRunner: (
    input: WorkerDispatchInput,
    options?: WorkerDispatchOptions,
  ) => Effect.Effect<WorkerDispatchReceipt, WorkerEngineError>;
  /**
   * Dispatches a worker under the durable WorkerEngine backbone, awaits completion,
   * acknowledges the resulting mailbox delivery, and cancels cleanly if interrupted.
   */
  readonly runAndCollect: (
    input: WorkerDispatchInput,
    options?: WorkerDispatchOptions,
  ) => Effect.Effect<WorkerRunAndCollectResult, WorkerEngineError>;
  readonly touchActivity: (dispatchId: string, toolSummary?: string | null) => Effect.Effect<void>;
  readonly check: (input: WorkerCheckInput) => Effect.Effect<WorkerCheckResult, WorkerEngineError>;
  readonly ack: (input: WorkerAckInput) => Effect.Effect<WorkerAckResult, WorkerEngineError>;
  readonly stop: (input: WorkerStopInput) => Effect.Effect<WorkerStopResult, WorkerEngineError>;
  readonly status: (filter?: {
    readonly threadId?: string | undefined;
    readonly runId?: string | undefined;
    readonly taskId?: string | undefined;
  }) => Effect.Effect<WorkerStatusResult, WorkerEngineError>;
  readonly getTask: (taskId: string) => Effect.Effect<WorkerTaskRecord | null, WorkerEngineError>;
  readonly getDispatch: (
    dispatchId: string,
  ) => Effect.Effect<WorkerDispatchRecord | null, WorkerEngineError>;
  readonly postMessage: (
    input: PostMailboxMessageInput,
  ) => Effect.Effect<WorkerMailboxMessageRecord, WorkerEngineError>;
  readonly recordWorkerDone: (input: {
    readonly taskId: string;
    readonly dispatchId: string;
    readonly fencingToken: number;
    readonly outcome: WorkerOutcome;
    readonly resultText?: string | null | undefined;
    readonly errorMessage?: string | null | undefined;
  }) => Effect.Effect<
    { readonly task: WorkerTaskRecord; readonly dispatch: WorkerDispatchRecord },
    WorkerEngineError
  >;
  readonly createGate: (
    input: WorkerGateCreateInput,
  ) => Effect.Effect<WorkerDecisionGateRecord, WorkerEngineError>;
  readonly resolveGate: (
    input: WorkerGateResolveInput,
  ) => Effect.Effect<WorkerDecisionGateRecord, WorkerEngineError>;
  readonly listGates: (filter?: {
    readonly taskId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly status?: WorkerDecisionGateStatus | undefined;
  }) => Effect.Effect<ReadonlyArray<WorkerDecisionGateRecord>, WorkerEngineError>;
  readonly inspectWorktreeDiff: (
    taskId: string,
  ) => Effect.Effect<WorkerWorktreeDiffResult, WorkerEngineError>;
  readonly mergeWorktree: (
    taskId: string,
  ) => Effect.Effect<WorkerWorktreeActionResult, WorkerEngineError>;
  readonly discardWorktree: (
    taskId: string,
  ) => Effect.Effect<WorkerWorktreeActionResult, WorkerEngineError>;
  readonly sweepHeartbeatsOnce: () => Effect.Effect<{
    readonly stalled: ReadonlyArray<string>;
    readonly aborted: ReadonlyArray<string>;
  }>;
  readonly fenceMailboxConsumer: (
    mailboxHandle: string,
    maxOldGeneration: number,
  ) => Effect.Effect<number, WorkerEngineError>;
}

export class WorkerEngineService extends Context.Service<
  WorkerEngineService,
  WorkerEngineServiceShape
>()("t3/t3x/workerEngine/WorkerEngineService") {}

export interface MakeWorkerEngineServiceOptions {
  readonly runner?: WorkerExecutionRunner | undefined;
  readonly heartbeat?: WorkerHeartbeatMonitorOptions | undefined;
  readonly reconcileOnBoot?: boolean | undefined;
}

export const makeWorkerEngineService = Effect.fn("WorkerEngineService.make")(function* (
  options?: MakeWorkerEngineServiceOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const executorOpt = yield* Effect.serviceOption(WorkspaceAgentExecutor);
  const projectionSnapshotQueryOpt = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const runner: WorkerExecutionRunner =
    options?.runner ?? makeDefaultExecutorRunner(executorOpt, projectionSnapshotQueryOpt);

  const store = makeWorkerEngineStore(sql);
  const mailbox = yield* makeWorkerMailboxService(sql, store);
  const heartbeat = yield* makeWorkerHeartbeatMonitor(store, mailbox, options?.heartbeat);
  const worktree = makeWorkerWorktreeLifecycle(store);
  const gates = makeWorkerDecisionGateService(sql, store, mailbox);

  const activeFibers = new Map<string, Fiber.Fiber<void, never>>();

  // Interrupt all live worker fibers cleanly on scope shutdown.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...activeFibers.values()],
      (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          activeFibers.clear();
        }),
      ),
    ),
  );

  // Boot-time recovery: settle stale `starting/running/stalled` dispatches from prior
  // server incarnations, preserve their worktrees in `review_ready`, and post 1 escalation mail each.
  if (options?.reconcileOnBoot !== false) {
    const reconciled = yield* store
      .reconcileInterruptedDispatches()
      .pipe(Effect.orElseSucceed(() => [] as const));
    for (const item of reconciled) {
      yield* mailbox
        .postMessage({
          runId: item.task.runId,
          threadId: item.task.threadId,
          taskId: item.task.taskId,
          dispatchId: item.dispatch.dispatchId,
          fencingToken: item.dispatch.fencingToken,
          fromActor: `dispatch:${item.dispatch.dispatchId}`,
          toActor: `run:${item.task.runId}`,
          type: "escalation",
          outcome: "failed",
          subject: `재시작으로 중단된 작업자: ${item.task.taskId}`,
          body: item.task.worktreePath
            ? `서버 재시작으로 디스패치 ${item.dispatch.dispatchId}가 중단되었습니다. worktree(${item.task.worktreePath}, 브랜치 ${item.task.worktreeBranch ?? ""})가 보존되어 있으므로 diff 검토 또는 --retry-of ${item.dispatch.dispatchId}로 이어받을 수 있습니다.`
            : `서버 재시작으로 디스패치 ${item.dispatch.dispatchId}가 중단되었습니다. --retry-of ${item.dispatch.dispatchId}로 재시도할 수 있습니다.`,
          payload: {
            kind: "interrupted_by_restart",
            worktreePath: item.task.worktreePath,
            worktreeBranch: item.task.worktreeBranch,
            worktreeState: item.task.worktreeState,
          },
        })
        .pipe(Effect.ignore);
    }
  }

  const settleAndNotify = (input: {
    readonly task: WorkerTaskRecord;
    readonly dispatch: WorkerDispatchRecord;
    readonly toActor: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly outcome: WorkerOutcome;
    readonly resultText?: string | null | undefined;
    readonly errorMessage?: string | null | undefined;
    readonly finalizeWorktree?: boolean | undefined;
    readonly skipLedger?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const freshTask = (yield* store.getTask(input.task.taskId)) ?? input.task;
      let filesModified = [...input.outcome.filesModified];
      let reviewHasChanges = false;
      let diffStat = "";

      if (input.finalizeWorktree !== false && freshTask.worktreePath) {
        const review = yield* worktree.finalizeForReview(freshTask).pipe(
          Effect.orElseSucceed(() => ({
            hasChanges: false,
            statusShort: "",
            diffStat: "",
            filesModified: [] as ReadonlyArray<string>,
          })),
        );
        filesModified = [...new Set([...filesModified, ...review.filesModified])];
        reviewHasChanges = review.hasChanges;
        diffStat = review.diffStat;
      }

      const finalOutcome: WorkerOutcome = {
        ...input.outcome,
        filesModified,
        worktreePath: freshTask.worktreePath,
        worktreeBranch: freshTask.worktreeBranch,
      };

      const settled = yield* store.completeDispatch({
        taskId: freshTask.taskId,
        dispatchId: input.dispatch.dispatchId,
        fencingToken: input.dispatch.fencingToken,
        status: input.status,
        outcome: finalOutcome,
        resultText: input.resultText ?? null,
        errorMessage: input.errorMessage ?? null,
      });

      const outboundMessages: PostMailboxMessageInput[] = [
        {
          runId: freshTask.runId,
          threadId: freshTask.threadId,
          taskId: freshTask.taskId,
          dispatchId: input.dispatch.dispatchId,
          fencingToken: input.dispatch.fencingToken,
          fromActor: `dispatch:${input.dispatch.dispatchId}`,
          toActor: input.toActor,
          type: "worker_done",
          outcome: finalOutcome.status,
          subject:
            finalOutcome.status === "succeeded"
              ? `작업 완료: ${freshTask.taskId} (${freshTask.role})`
              : `작업 실패(${input.status}): ${freshTask.taskId} (${freshTask.role})`,
          body: finalOutcome.summary,
          payload: {
            outcome: finalOutcome,
            resultText: input.resultText ?? null,
            errorMessage: input.errorMessage ?? null,
          },
        },
      ];

      if (freshTask.worktreePath && reviewHasChanges) {
        outboundMessages.push({
          runId: freshTask.runId,
          threadId: freshTask.threadId,
          taskId: freshTask.taskId,
          dispatchId: input.dispatch.dispatchId,
          fencingToken: input.dispatch.fencingToken,
          fromActor: `dispatch:${input.dispatch.dispatchId}`,
          toActor: input.toActor,
          type: "merge_ready",
          subject: `Worktree 검토 준비: ${freshTask.worktreeBranch ?? freshTask.taskId}`,
          body: diffStat || `변경 파일 ${filesModified.length}건이 worktree에 보존되어 있습니다.`,
          payload: {
            taskId: freshTask.taskId,
            worktreePath: freshTask.worktreePath,
            worktreeBranch: freshTask.worktreeBranch,
            filesModified,
          },
        });
      }

      yield* mailbox.postMessages(outboundMessages);

      if (!input.skipLedger) {
        unifiedExecutionLedger.finish({
          executionId: input.dispatch.dispatchId,
          executionKind: "workspace_delegate",
          status: input.status,
          errorMessage: input.errorMessage ?? null,
        });
      }

      return settled;
    });

  const dispatchWithRunner: WorkerEngineServiceShape["dispatchWithRunner"] = Effect.fn(
    "WorkerEngineService.dispatch",
  )(function* (input, dispatchOptions) {
    const runId = input.runId?.trim() || `run_${input.threadId.slice(0, 12)}`;
    const toActor = input.toActor?.trim() || `run:${runId}`;
    const callerKind = input.callerKind ?? "cli";
    const requestedWorktreeMode = resolveDefaultWorktreeMode(input.role, input.worktreeMode);
    const activeRunner = dispatchOptions?.runner ?? runner;
    const skipLedger = dispatchOptions?.skipLedger === true;

    const unavailableReason = getUnavailableModelReason(
      input.targetInstanceId,
      input.targetModel ?? null,
    );
    if (unavailableReason) {
      return yield* new WorkerEngineError({
        code: "invalid_state",
        message: unavailableReason,
        details: {
          modelUnavailable: true,
          providerInstanceId: input.targetInstanceId,
          model: input.targetModel ?? null,
        },
      });
    }

    const claimed = yield* store.claimTaskAndDispatch({
      taskId: input.taskId,
      dispatchId: dispatchOptions?.dispatchId,
      runId,
      threadId: input.threadId,
      ownerTurnId: input.ownerTurnId ?? null,
      callerKind,
      idempotencyKey: input.idempotencyKey ?? null,
      retryOfDispatchId: input.retryOfDispatchId ?? null,
      allowDuplicate: dispatchOptions?.allowDuplicate,
      role: input.role,
      targetInstanceId: input.targetInstanceId,
      targetModel: input.targetModel ?? null,
      specText: input.specText,
      ragFactsJson:
        input.ragFacts && input.ragFacts.length > 0 ? JSON.stringify(input.ragFacts) : null,
      cwd: input.cwd,
      worktreeMode: dispatchOptions?.externalWorktree ? "isolated" : requestedWorktreeMode,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs,
      maxRunningPerThread: dispatchOptions?.maxRunningPerThread,
    });

    yield* annotateExecutionSpan({
      executionKind: "workspace_delegate",
      executionId: claimed.dispatch.dispatchId,
      threadId: claimed.task.threadId,
      parentRunId: claimed.task.runId,
      provider: claimed.dispatch.providerInstanceId,
      model: claimed.dispatch.model,
    });
    yield* Effect.annotateCurrentSpan({
      "t3.task_id": claimed.task.taskId,
      "t3.dispatch_id": claimed.dispatch.dispatchId,
      ...(claimed.task.ownerTurnId ? { "t3.turn_id": claimed.task.ownerTurnId } : {}),
    });

    // Deduplicated or idempotent hit: never spawn a second worker!
    if (claimed.deduplicated || claimed.reusedIdempotency) {
      return {
        taskId: claimed.task.taskId,
        dispatchId: claimed.dispatch.dispatchId,
        runId: claimed.task.runId,
        fencingToken: claimed.dispatch.fencingToken,
        deduplicated: claimed.deduplicated,
        reusedIdempotency: claimed.reusedIdempotency,
        status: claimed.task.status,
        dispatchStatus: claimed.dispatch.status,
        worktreeMode: claimed.task.worktreeMode,
        worktreePath: claimed.task.worktreePath,
        worktreeBranch: claimed.task.worktreeBranch,
        worktreeState: claimed.task.worktreeState,
        gateId: null,
      };
    }

    // Prepare worktree (or bind caller-provisioned external worktree).
    const prepared = dispatchOptions?.externalWorktree
      ? {
          worktreeMode: "isolated" as const,
          worktreePath: dispatchOptions.externalWorktree.worktreePath,
          worktreeBranch: dispatchOptions.externalWorktree.worktreeBranch,
          worktreeBaseRef: input.baseBranch ?? null,
          worktreeState: "active" as const,
          effectiveCwd: dispatchOptions.externalWorktree.worktreePath,
        }
      : yield* worktree.prepareWorktree({
          cwd: claimed.task.cwd,
          taskId: claimed.task.taskId,
          mode: requestedWorktreeMode,
          baseBranch: input.baseBranch,
        });
    const taskWithWorktree = yield* store.updateTaskWorktree({
      taskId: claimed.task.taskId,
      worktreeMode: prepared.worktreeMode,
      worktreePath: prepared.worktreePath,
      worktreeBranch: prepared.worktreeBranch,
      worktreeBaseRef: prepared.worktreeBaseRef,
      worktreeState: prepared.worktreeState,
    });

    // Decision gate requested before executing a risky task.
    if (input.requireApproval) {
      const gate = yield* gates.createGate({
        taskId: taskWithWorktree.taskId,
        dispatchId: claimed.dispatch.dispatchId,
        fencingToken: claimed.dispatch.fencingToken,
        riskLevel: input.approvalRiskLevel ?? "high",
        question:
          input.approvalQuestion?.trim() ||
          `위험 작업(${taskWithWorktree.role}) 실행을 승인하시겠습니까?`,
        options: ["approve", "deny"],
      });
      yield* store.abandonPreFlightDispatch(taskWithWorktree.taskId, claimed.dispatch.dispatchId);
      return {
        taskId: taskWithWorktree.taskId,
        dispatchId: claimed.dispatch.dispatchId,
        runId: taskWithWorktree.runId,
        fencingToken: claimed.dispatch.fencingToken,
        deduplicated: false,
        reusedIdempotency: false,
        status: "blocked",
        dispatchStatus: "abandoned",
        worktreeMode: taskWithWorktree.worktreeMode,
        worktreePath: taskWithWorktree.worktreePath,
        worktreeBranch: taskWithWorktree.worktreeBranch,
        worktreeState: taskWithWorktree.worktreeState,
        gateId: gate.gateId,
      };
    }

    if (!skipLedger) {
      unifiedExecutionLedger.begin({
        executionId: claimed.dispatch.dispatchId,
        executionKind: "workspace_delegate",
        threadId: taskWithWorktree.threadId,
        parentRunId: taskWithWorktree.runId,
        summary: `[${taskWithWorktree.role}] ${taskWithWorktree.specText.slice(0, 120)}`,
        provider: claimed.dispatch.providerInstanceId,
        model: claimed.dispatch.model,
        startedAtMs: claimed.dispatch.startedAtMs,
      });
    }

    const startedAtMs = claimed.dispatch.startedAtMs;
    let latestPartialOutput = "";
    let timedOutReason: string | null = null;

    const onTimeoutAbort = (reason: string) =>
      Effect.gen(function* () {
        timedOutReason = reason;
        const runningFiber = activeFibers.get(claimed.dispatch.dispatchId);
        activeFibers.delete(claimed.dispatch.dispatchId);
        if (runningFiber) {
          yield* Fiber.interrupt(runningFiber).pipe(Effect.ignore);
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const preserved = latestPartialOutput.trim();
        const timeoutSummary = preserved
          ? `${reason} (부분 출력 ${preserved.length}자 보존됨)`
          : reason;
        yield* settleAndNotify({
          task: taskWithWorktree,
          dispatch: claimed.dispatch,
          toActor,
          status: "failed",
          outcome: {
            status: "failed",
            summary: timeoutSummary,
            filesModified: [],
            exitCode: 124,
            latencyMs: Math.max(0, nowMs - startedAtMs),
            provider: claimed.dispatch.providerInstanceId,
            model: claimed.dispatch.model ?? "default",
          },
          resultText: preserved || null,
          errorMessage: timeoutSummary,
          skipLedger,
        }).pipe(Effect.ignore);
      });

    yield* heartbeat.register({
      taskId: taskWithWorktree.taskId,
      dispatchId: claimed.dispatch.dispatchId,
      runId: taskWithWorktree.runId,
      threadId: taskWithWorktree.threadId,
      fencingToken: claimed.dispatch.fencingToken,
      toActor,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs,
      maxIdleMs: input.maxIdleMs,
      maxWallTimeMs: input.maxWallTimeMs ?? null,
      onTimeoutAbort,
    });

    const workerProgram = Effect.gen(function* () {
      yield* annotateExecutionSpan({
        executionKind: "workspace_delegate",
        executionId: claimed.dispatch.dispatchId,
        threadId: taskWithWorktree.threadId,
        parentRunId: taskWithWorktree.runId,
        provider: claimed.dispatch.providerInstanceId,
        model: claimed.dispatch.model,
      });
      yield* Effect.annotateCurrentSpan({
        "t3.task_id": taskWithWorktree.taskId,
        "t3.dispatch_id": claimed.dispatch.dispatchId,
      });

      yield* store.markDispatchRunning(claimed.dispatch.dispatchId, claimed.dispatch.fencingToken);
      const runResult = yield* Effect.result(
        activeRunner({
          task: taskWithWorktree,
          dispatch: claimed.dispatch,
          effectiveCwd: prepared.effectiveCwd,
          onActivity: (toolSummary) =>
            heartbeat.touchActivity(claimed.dispatch.dispatchId, toolSummary),
          onPartialOutput: (fullOutput) => {
            if (fullOutput.length >= latestPartialOutput.length) {
              latestPartialOutput = fullOutput;
            }
          },
        }),
      );

      yield* heartbeat.unregister(claimed.dispatch.dispatchId);
      activeFibers.delete(claimed.dispatch.dispatchId);
      const finishedAtMs = yield* Clock.currentTimeMillis;

      if (runResult._tag === "Success") {
        const out = runResult.success;
        yield* settleAndNotify({
          task: taskWithWorktree,
          dispatch: claimed.dispatch,
          toActor,
          status: "completed",
          outcome: {
            status: "succeeded",
            summary: out.summary?.trim() || out.resultText.slice(0, 400) || "작업 완료",
            filesModified: [...(out.filesModified ?? [])],
            ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}),
            latencyMs: Math.max(0, finishedAtMs - startedAtMs),
            provider: claimed.dispatch.providerInstanceId,
            model: claimed.dispatch.model ?? "default",
            ...(out.inputTokens !== undefined ? { inputTokens: out.inputTokens } : {}),
            ...(out.outputTokens !== undefined ? { outputTokens: out.outputTokens } : {}),
          },
          resultText: out.resultText,
          skipLedger,
        }).pipe(Effect.ignore);
      } else {
        const failure = runResult.failure;
        const errMsg = timedOutReason ?? failure.message;
        const detailsPartial =
          typeof failure.details?.partialOutput === "string" ? failure.details.partialOutput : "";
        const preserved = (detailsPartial || latestPartialOutput).trim();
        recordUnavailableModelFromError({
          providerInstanceId: claimed.dispatch.providerInstanceId,
          model: claimed.dispatch.model,
          errorMessage: errMsg,
        });
        yield* settleAndNotify({
          task: taskWithWorktree,
          dispatch: claimed.dispatch,
          toActor,
          status: "failed",
          outcome: {
            status: "failed",
            summary: errMsg,
            filesModified: [],
            exitCode: timedOutReason ? 124 : 1,
            latencyMs: Math.max(0, finishedAtMs - startedAtMs),
            provider: claimed.dispatch.providerInstanceId,
            model: claimed.dispatch.model ?? "default",
          },
          resultText: preserved || null,
          errorMessage: errMsg,
          skipLedger,
        }).pipe(Effect.ignore);
        // Propagate failure inside `WorkerEngineService.executeWorker` span so span status
        // matches `runAndCollect` and persisted task/dispatch failure instead of masking as Success.
        return yield* Effect.fail(failure);
      }
    }).pipe(
      Effect.withSpan("WorkerEngineService.executeWorker"),
      Effect.catch(() => Effect.void),
    );

    const fiber = yield* Effect.forkIn(workerProgram, scope);
    activeFibers.set(claimed.dispatch.dispatchId, fiber);

    return {
      taskId: taskWithWorktree.taskId,
      dispatchId: claimed.dispatch.dispatchId,
      runId: taskWithWorktree.runId,
      fencingToken: claimed.dispatch.fencingToken,
      deduplicated: false,
      reusedIdempotency: false,
      status: taskWithWorktree.status,
      dispatchStatus: claimed.dispatch.status,
      worktreeMode: taskWithWorktree.worktreeMode,
      worktreePath: taskWithWorktree.worktreePath,
      worktreeBranch: taskWithWorktree.worktreeBranch,
      worktreeState: taskWithWorktree.worktreeState,
      gateId: null,
    };
  });

  const dispatch: WorkerEngineServiceShape["dispatch"] = (input) => dispatchWithRunner(input);

  const runAndCollect: WorkerEngineServiceShape["runAndCollect"] = Effect.fn(
    "WorkerEngineService.runAndCollect",
  )(function* (input, dispatchOptions) {
    const runId = input.runId?.trim() || `run_${input.threadId.slice(0, 12)}`;
    const uniqueSuffix =
      dispatchOptions?.dispatchId?.trim() ||
      input.taskId?.trim() ||
      `rc_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const toActor = input.toActor?.trim() || `run:${runId}:caller:${uniqueSuffix}`;
    const receipt = yield* dispatchWithRunner({ ...input, runId, toActor }, dispatchOptions);

    return yield* Effect.gen(function* () {
      const liveFiber = activeFibers.get(receipt.dispatchId);
      if (liveFiber) {
        yield* Fiber.await(liveFiber).pipe(Effect.asVoid);
      }

      // Acknowledge mailbox delivery generated for this dispatch so caller mailbox stays clean.
      const checked = yield* mailbox
        .checkMailbox({
          runId: receipt.runId,
          toActor,
          wait: false,
          limit: 50,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (checked?.deliveryId) {
        yield* mailbox.ackDelivery({ deliveryId: checked.deliveryId }).pipe(Effect.ignore);
      }

      const settledDispatch = yield* store.getDispatch(receipt.dispatchId);
      const settledTask = yield* store.getTask(receipt.taskId);
      if (!settledDispatch) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Dispatch '${receipt.dispatchId}' disappeared after execution.`,
        });
      }
      if (settledDispatch.status !== "completed") {
        const errMsg =
          settledDispatch.errorMessage ??
          `Worker dispatch '${settledDispatch.dispatchId}' ended with status '${settledDispatch.status}'.`;
        const isTimedOut = errMsg.includes("시간 초과");
        return yield* new WorkerEngineError({
          code:
            settledDispatch.status === "cancelled" && !isTimedOut ? "conflict" : "invalid_state",
          message: errMsg,
          details: {
            dispatchId: settledDispatch.dispatchId,
            status: settledDispatch.status,
            interrupted: settledDispatch.status === "cancelled" && !isTimedOut,
            timedOut: isTimedOut,
            ...(settledDispatch.resultText ? { partialOutput: settledDispatch.resultText } : {}),
          },
        });
      }
      return {
        taskId: receipt.taskId,
        dispatchId: receipt.dispatchId,
        runId: receipt.runId,
        resultText: settledDispatch.resultText ?? "",
        worktreePath: settledTask?.worktreePath ?? receipt.worktreePath,
        worktreeBranch: settledTask?.worktreeBranch ?? receipt.worktreeBranch,
      };
    }).pipe(
      Effect.onInterrupt(() =>
        stop({
          dispatchId: receipt.dispatchId,
          reason: "호출자 인터럽트로 작업자 실행이 중단되었습니다.",
        }).pipe(Effect.ignore),
      ),
    );
  });

  const stop: WorkerEngineServiceShape["stop"] = Effect.fn("WorkerEngineService.stop")(
    function* (input) {
      const existing = yield* store.getDispatch(input.dispatchId);
      if (!existing) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Dispatch '${input.dispatchId}' not found.`,
        });
      }
      const task = yield* store.getTask(existing.taskId);
      if (!task) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${existing.taskId}' not found.`,
        });
      }
      if (
        existing.status !== "starting" &&
        existing.status !== "running" &&
        existing.status !== "stalled"
      ) {
        return {
          dispatchId: existing.dispatchId,
          taskId: existing.taskId,
          stopped: false,
          status: existing.status,
          alreadyTerminated: true,
          message: "이미 종료됨",
        };
      }

      const fiber = activeFibers.get(existing.dispatchId);
      activeFibers.delete(existing.dispatchId);
      yield* heartbeat.unregister(existing.dispatchId);
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }

      // Re-read after interrupt: if the dispatch already reached a terminal state
      // (or was superseded), treat this stop request cleanly as already terminated
      // instead of failing with a stale-dispatch fencing error.
      const latestAfterInterrupt = yield* store.getDispatch(existing.dispatchId);
      if (
        latestAfterInterrupt &&
        latestAfterInterrupt.status !== "starting" &&
        latestAfterInterrupt.status !== "running" &&
        latestAfterInterrupt.status !== "stalled"
      ) {
        return {
          dispatchId: latestAfterInterrupt.dispatchId,
          taskId: latestAfterInterrupt.taskId,
          stopped: false,
          status: latestAfterInterrupt.status,
          alreadyTerminated: true,
          message: "이미 종료됨",
        };
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const reason = input.reason?.trim() || "감독 요청에 의해 중단됨";
      const settleExit = yield* Effect.result(
        settleAndNotify({
          task,
          dispatch: existing,
          toActor: `run:${task.runId}`,
          status: "cancelled",
          outcome: {
            status: "failed",
            summary: reason,
            filesModified: [],
            latencyMs: Math.max(0, nowMs - existing.startedAtMs),
            provider: existing.providerInstanceId,
            model: existing.model ?? "default",
          },
          errorMessage: reason,
        }),
      );

      if (settleExit._tag === "Failure") {
        if (settleExit.failure.code === "fencing_rejected") {
          const latestOnRace = yield* store
            .getDispatch(existing.dispatchId)
            .pipe(Effect.orElseSucceed(() => null));
          return {
            dispatchId: existing.dispatchId,
            taskId: existing.taskId,
            stopped: false,
            status: latestOnRace?.status ?? existing.status,
            alreadyTerminated: true,
            message: "이미 종료됨",
          };
        }
        return yield* Effect.fail(settleExit.failure);
      }

      return {
        dispatchId: existing.dispatchId,
        taskId: existing.taskId,
        stopped: true,
        status: "cancelled",
      };
    },
  );

  const recordWorkerDone: WorkerEngineServiceShape["recordWorkerDone"] = Effect.fn(
    "WorkerEngineService.recordWorkerDone",
  )(function* (input) {
    const { task, dispatch: activeDispatch } = yield* store.assertActiveFencing(
      input.taskId,
      input.dispatchId,
      input.fencingToken,
    );
    const fiber = activeFibers.get(activeDispatch.dispatchId);
    activeFibers.delete(activeDispatch.dispatchId);
    yield* heartbeat.unregister(activeDispatch.dispatchId);
    if (fiber) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
    return yield* settleAndNotify({
      task,
      dispatch: activeDispatch,
      toActor: `run:${task.runId}`,
      status: input.outcome.status === "succeeded" ? "completed" : "failed",
      outcome: input.outcome,
      resultText: input.resultText ?? null,
      errorMessage: input.errorMessage ?? null,
    });
  });

  const status: WorkerEngineServiceShape["status"] = Effect.fn("WorkerEngineService.status")(
    function* (filter) {
      const [tasks, activeDispatches, openGates, unreadMailboxCount] = yield* Effect.all([
        store.listTasks(filter),
        store.listActiveDispatches(filter),
        gates.listGates({
          taskId: filter?.taskId,
          threadId: filter?.threadId,
          status: "open",
        }),
        mailbox.countUnread({
          runId: filter?.runId,
          threadId: filter?.threadId,
        }),
      ]);
      return {
        tasks: [...tasks],
        activeDispatches: [...activeDispatches],
        openGates: [...openGates],
        unreadMailboxCount,
      };
    },
  );

  return {
    dispatch,
    dispatchWithRunner,
    runAndCollect,
    touchActivity: heartbeat.touchActivity,
    check: mailbox.checkMailbox,
    ack: mailbox.ackDelivery,
    stop,
    status,
    getTask: store.getTask,
    getDispatch: store.getDispatch,
    postMessage: mailbox.postMessage,
    recordWorkerDone,
    createGate: gates.createGate,
    resolveGate: gates.resolveGate,
    listGates: gates.listGates,
    inspectWorktreeDiff: worktree.inspectDiff,
    mergeWorktree: (taskId) => worktree.mergeWorktree(taskId),
    discardWorktree: (taskId) => worktree.discardWorktree(taskId),
    sweepHeartbeatsOnce: heartbeat.sweepOnce,
    fenceMailboxConsumer: mailbox.fenceOutstandingDeliveries,
  } satisfies WorkerEngineServiceShape;
});

export const WorkerEngineServiceLive = Layer.effect(WorkerEngineService, makeWorkerEngineService());

export const makeWorkerEngineServiceLayer = (options?: MakeWorkerEngineServiceOptions) =>
  Layer.effect(WorkerEngineService, makeWorkerEngineService(options));
