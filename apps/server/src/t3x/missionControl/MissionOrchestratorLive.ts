// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  MissionControlError,
  ProviderExecutionId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAgentExecutor } from "../../orchestration/Services/WorkspaceAgentExecutor.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { WorkerEngineService } from "../workerEngine/WorkerEngineService.ts";
import { WorkerEngineError } from "../workerEngine/WorkerEngineStore.ts";
import {
  MissionOrchestratorService,
  makeMissionOrchestrator,
  type MissionCrewStepOutput,
} from "./MissionOrchestratorService.ts";

export interface ResolvedMissionThreadModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * 자율 운영실 크루 실행은 소유 채팅방의 `runtimeMode` / `interactionMode`를 그대로 상속한다.
 * 역할(`planner`/`reviewer`/`coder`)을 이유로 `full-access` 채팅방을 `approval-required`/`plan`으로
 * 강제 격하하거나, 반대로 `approval-required` 채팅방을 `full-access`로 강제 승격하지 않는다.
 */
export function resolveMissionThreadModes(
  projectionSnapshotQuery: ProjectionSnapshotQuery["Service"],
  threadId: ThreadId,
  fallbackModes?: ResolvedMissionThreadModes,
): Effect.Effect<ResolvedMissionThreadModes> {
  const fromDirectContext =
    typeof projectionSnapshotQuery.getThreadRuntimeContext === "function"
      ? Effect.suspend(() => projectionSnapshotQuery.getThreadRuntimeContext(threadId)).pipe(
          Effect.map((opt) =>
            Option.isSome(opt)
              ? {
                  runtimeMode: opt.value.runtimeMode,
                  interactionMode: opt.value.interactionMode,
                }
              : null,
          ),
          Effect.catchCause(() => Effect.succeed(null)),
        )
      : Effect.succeed(null);

  const fromShellFallback =
    typeof projectionSnapshotQuery.getShellSnapshot === "function"
      ? Effect.suspend(() => projectionSnapshotQuery.getShellSnapshot()).pipe(
          Effect.map((shell) => {
            const found = shell.threads.find((t) => t.id === threadId);
            return found
              ? {
                  runtimeMode: found.runtimeMode,
                  interactionMode: found.interactionMode,
                }
              : null;
          }),
          Effect.catchCause(() => Effect.succeed(null)),
        )
      : Effect.succeed(null);

  return Effect.gen(function* () {
    const direct = yield* fromDirectContext;
    const resolved = direct ?? (yield* fromShellFallback);
    return {
      runtimeMode: resolved?.runtimeMode ?? fallbackModes?.runtimeMode ?? "approval-required",
      interactionMode: resolved?.interactionMode ?? fallbackModes?.interactionMode ?? "default",
    };
  });
}

function collectRuntimeToolFailure(event: ProviderRuntimeEvent, failures: string[]): void {
  if (event.type !== "item.completed") return;
  const payload = event.payload as {
    readonly status?: unknown;
    readonly title?: unknown;
    readonly detail?: unknown;
    readonly itemType?: unknown;
  };
  if (payload?.status !== "failed") return;
  const label =
    (typeof payload.title === "string" && payload.title.trim()) ||
    (typeof payload.itemType === "string" && payload.itemType.trim()) ||
    "도구 실행";
  const detail =
    typeof payload.detail === "string" && payload.detail.trim()
      ? `: ${payload.detail.trim().slice(0, 120)}`
      : "";
  if (failures.length < 5) {
    failures.push(`${label}${detail}`);
  }
}

function formatEmptyCrewResponseError(
  roleDisplayName: string,
  toolFailures: ReadonlyArray<string>,
): string {
  const base = `${roleDisplayName} 크루가 최종 응답 없이 종료되었습니다(빈 응답).`;
  if (toolFailures.length === 0) return base;
  return `${base} 도구 실패 ${toolFailures.length}건 (${toolFailures.join("; ")})`;
}

/**
 * MissionOrchestratorLive: 실제 T3 런타임(SQLite + ProviderRegistry + OrchestrationEngine +
 * WorkerEngineService + WorkspaceAgentExecutor)과 자율 미션 컨트롤을 연결한다.
 */
export const MissionOrchestratorLive = Layer.effect(
  MissionOrchestratorService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providerRegistry = yield* ProviderRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const agentExecutor = yield* WorkspaceAgentExecutor;
    const orchestrationEngineOpt = yield* Effect.serviceOption(OrchestrationEngineService);
    const workerEngineOpt = yield* Effect.serviceOption(WorkerEngineService);
    const createdThreadModes = new Map<string, ResolvedMissionThreadModes>();

    return yield* makeMissionOrchestrator({
      sql,

      resolveProjectContext: (projectId) =>
        Effect.gen(function* () {
          const [providers, shell] = yield* Effect.all([
            providerRegistry.getProviders,
            projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.mapError(
                (err) =>
                  new MissionControlError({
                    code: "EXECUTION_FAILED",
                    message: `워크스페이스 스냅샷 조회 실패: ${err.message}`,
                  }),
              ),
            ),
          ]);
          const project = shell.projects.find((p) => p.id === projectId);
          if (!project) {
            return yield* Effect.fail(
              new MissionControlError({
                code: "NOT_FOUND",
                message: `프로젝트 '${projectId}'을(를) 찾을 수 없습니다.`,
              }),
            );
          }
          return {
            projectId,
            projectTitle: project.title,
            workspaceRoot: project.workspaceRoot,
            providers,
          };
        }),

      ...(Option.isSome(orchestrationEngineOpt)
        ? {
            createProjectThread: ({ projectId, title, providerInstanceId, modelSlug }) =>
              Effect.gen(function* () {
                const threadId = ThreadId.make(
                  `mth_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                );
                const nowIso = DateTime.formatIso(yield* DateTime.now);
                yield* orchestrationEngineOpt.value
                  .dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(`mission-thread-create:${threadId}`),
                    threadId,
                    projectId,
                    title,
                    modelSelection: {
                      instanceId: ProviderInstanceId.make(providerInstanceId),
                      model: modelSlug,
                    },
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    orchestraRunThreadId: null,
                    createdAt: nowIso,
                  })
                  .pipe(
                    Effect.mapError(
                      (err) =>
                        new MissionControlError({
                          code: "EXECUTION_FAILED",
                          message: `미션 대화창 생성 실패: ${err.message}`,
                        }),
                    ),
                  );
                createdThreadModes.set(String(threadId), {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
                return threadId;
              }),

            publishThreadMessage: ({ threadId, messageKey, markdown }) =>
              Effect.gen(function* () {
                const messageId = MessageId.make(messageKey.slice(0, 120));
                const nowIso = DateTime.formatIso(yield* DateTime.now);
                yield* orchestrationEngineOpt.value.dispatch({
                  type: "thread.message.assistant.delta",
                  commandId: CommandId.make(`${messageKey}:delta`),
                  threadId,
                  messageId,
                  delta: markdown,
                  createdAt: nowIso,
                });
                yield* orchestrationEngineOpt.value.dispatch({
                  type: "thread.message.assistant.complete",
                  commandId: CommandId.make(`${messageKey}:complete`),
                  threadId,
                  messageId,
                  createdAt: nowIso,
                });
              }).pipe(Effect.catch(() => Effect.void)),
          }
        : {}),

      runCrewStep: (step) =>
        Effect.gen(function* () {
          const dispatchId = `mdisp_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
          const nowIso = DateTime.formatIso(yield* DateTime.now);
          const threadModes = yield* resolveMissionThreadModes(
            projectionSnapshotQuery,
            step.threadId,
            createdThreadModes.get(String(step.threadId)),
          );

          if (Option.isSome(workerEngineOpt)) {
            const collected = yield* workerEngineOpt.value
              .runAndCollect(
                {
                  runId: step.missionId,
                  threadId: step.threadId,
                  callerKind: "orchestra",
                  role: step.isWriteRole ? "coder" : "reviewer",
                  targetInstanceId: step.providerInstanceId,
                  targetModel: step.modelSlug,
                  specText: step.prompt.slice(0, 16_000),
                  cwd: step.cwd,
                  worktreeMode: step.isWriteRole ? "isolated" : "current",
                },
                {
                  dispatchId,
                  allowDuplicate: true,
                  maxRunningPerThread: 16,
                  ...(step.worktreePath
                    ? {
                        externalWorktree: {
                          worktreePath: step.worktreePath,
                          worktreeBranch: step.worktreeBranch ?? null,
                        },
                      }
                    : {}),
                  runner: (req) => {
                    const toolFailures: string[] = [];
                    return agentExecutor
                      .execute({
                        usageWorkId: `mission:${step.missionId}:${step.role.roleKey}:${dispatchId}`,
                        execution: {
                          executionId: ProviderExecutionId.make(dispatchId),
                          ownerThreadId: step.threadId,
                          runId: WorkspaceCollaborationRunId.make(step.missionId),
                          nodeId: WorkspaceTaskNodeId.make(
                            `msn_${step.role.roleKey}_${dispatchId}`
                              .replace(/[^A-Za-z0-9._-]/g, "_")
                              .slice(0, 64),
                          ),
                          attempt: 1,
                        },
                        modelSelection: {
                          instanceId: ProviderInstanceId.make(step.providerInstanceId),
                          model: step.modelSlug,
                        },
                        runtimeMode: threadModes.runtimeMode,
                        interactionMode: threadModes.interactionMode,
                        cwd: req.effectiveCwd,
                        prompt: step.prompt,
                        title: `자율 미션 (${step.role.displayName})`,
                        displayName: step.displayName,
                        role: step.isWriteRole ? "implementer" : "reviewer",
                        kind: step.isWriteRole ? "implementation" : "validation",
                        startedAt: nowIso,
                        onRuntimeEvent: (ev) =>
                          Effect.sync(() => {
                            collectRuntimeToolFailure(ev, toolFailures);
                          }).pipe(Effect.andThen(req.onActivity(ev.type).pipe(Effect.ignore))),
                      })
                      .pipe(
                        Effect.mapError(
                          (err) =>
                            new WorkerEngineError({
                              code: "invalid_state",
                              message: err.message,
                            }),
                        ),
                        Effect.flatMap((resultText) =>
                          resultText.trim().length === 0
                            ? Effect.fail(
                                new WorkerEngineError({
                                  code: "invalid_state",
                                  message: formatEmptyCrewResponseError(
                                    step.role.displayName,
                                    toolFailures,
                                  ),
                                }),
                              )
                            : Effect.succeed({
                                resultText,
                                summary: resultText.slice(0, 400),
                                exitCode: 0,
                              }),
                        ),
                      );
                  },
                },
              )
              .pipe(
                Effect.mapError(
                  (err) =>
                    new MissionControlError({
                      code: "EXECUTION_FAILED",
                      message: err.message,
                    }),
                ),
              );

            return {
              resultText: collected.resultText,
              exitCode: 0,
              taskId: collected.taskId,
              worktreePath: collected.worktreePath,
              worktreeBranch: collected.worktreeBranch,
            } satisfies MissionCrewStepOutput;
          }

          // WorkerEngineService 미제공 환경 폴백: WorkspaceAgentExecutor 직접 실행
          const fallbackToolFailures: string[] = [];
          const resultText = yield* agentExecutor
            .execute({
              usageWorkId: `mission:${step.missionId}:${step.role.roleKey}:${dispatchId}`,
              execution: {
                executionId: ProviderExecutionId.make(dispatchId),
                ownerThreadId: step.threadId,
                runId: WorkspaceCollaborationRunId.make(step.missionId),
                nodeId: WorkspaceTaskNodeId.make(
                  `msn_${step.role.roleKey}_${dispatchId}`
                    .replace(/[^A-Za-z0-9._-]/g, "_")
                    .slice(0, 64),
                ),
                attempt: 1,
              },
              modelSelection: {
                instanceId: ProviderInstanceId.make(step.providerInstanceId),
                model: step.modelSlug,
              },
              runtimeMode: threadModes.runtimeMode,
              interactionMode: threadModes.interactionMode,
              cwd: step.cwd,
              prompt: step.prompt,
              title: `자율 미션 (${step.role.displayName})`,
              displayName: step.displayName,
              role: step.isWriteRole ? "implementer" : "reviewer",
              kind: step.isWriteRole ? "implementation" : "validation",
              startedAt: nowIso,
              onRuntimeEvent: (ev) =>
                Effect.sync(() => {
                  collectRuntimeToolFailure(ev, fallbackToolFailures);
                }),
            })
            .pipe(
              Effect.mapError(
                (err) =>
                  new MissionControlError({
                    code: "EXECUTION_FAILED",
                    message: err.message,
                  }),
              ),
              Effect.flatMap((text) =>
                text.trim().length === 0
                  ? Effect.fail(
                      new MissionControlError({
                        code: "EXECUTION_FAILED",
                        message: formatEmptyCrewResponseError(
                          step.role.displayName,
                          fallbackToolFailures,
                        ),
                      }),
                    )
                  : Effect.succeed(text),
              ),
            );

          return {
            resultText,
            exitCode: 0,
            taskId: null,
            worktreePath: step.worktreePath ?? null,
            worktreeBranch: step.worktreeBranch ?? null,
          } satisfies MissionCrewStepOutput;
        }),

      ...(Option.isSome(workerEngineOpt)
        ? {
            mergeWorktree: (taskId) =>
              workerEngineOpt.value.mergeWorktree(taskId).pipe(
                Effect.map((r) => r.message),
                Effect.mapError(
                  (err) =>
                    new MissionControlError({
                      code: "EXECUTION_FAILED",
                      message: err.message,
                    }),
                ),
              ),
            discardWorktree: (taskId) =>
              workerEngineOpt.value.discardWorktree(taskId).pipe(
                Effect.map((r) => r.message),
                Effect.mapError(
                  (err) =>
                    new MissionControlError({
                      code: "EXECUTION_FAILED",
                      message: err.message,
                    }),
                ),
              ),
          }
        : {}),
    });
  }),
);
