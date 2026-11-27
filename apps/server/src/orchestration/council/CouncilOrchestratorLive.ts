// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  CouncilError,
  MessageId,
  ProviderExecutionId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  isProviderAvailable,
  resolveSubordinateTeam,
  type ModelTargetRef,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { WorktreeProvisionService } from "../../git/WorktreeProvisionService.ts";
import { makeCouncilStore } from "../../persistence/CouncilStore.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  getUnavailableModelReason,
  probeModelAvailabilityBeforeDispatch,
  recordUnavailableModelFromError,
} from "../../provider/workerFailurePolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutionError,
  WorkspaceAgentExecutor,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { WorkerEngineService } from "../../t3x/workerEngine/WorkerEngineService.ts";
import { WorkerEngineError } from "../../t3x/workerEngine/WorkerEngineStore.ts";
import {
  CouncilOrchestratorService,
  makeCouncilOrchestrator,
  extractStructuredTagJson,
} from "./CouncilOrchestrator.ts";
import {
  buildSubordinateSlotsFromTeam,
  type TargetHealthAssessment,
} from "./DynamicCouncilRoster.ts";

function defaultModelForProvider(provider: ServerProvider): string | null {
  const nonLegacy = provider.models.find((m) => !m.isLegacy && m.isDefault);
  if (nonLegacy) return nonLegacy.slug;
  const active = provider.models.find((m) => !m.isLegacy);
  return active?.slug ?? provider.models[0]?.slug ?? null;
}

function assessProviderSnapshotHealth(
  provider: ServerProvider | undefined,
  rateLimitedIds: ReadonlySet<string>,
): TargetHealthAssessment {
  if (!provider) {
    return { healthy: false, reason: "프로바이더 인스턴스를 찾을 수 없습니다." };
  }
  if (!isProviderAvailable(provider) || !provider.enabled) {
    return { healthy: false, reason: `${provider.displayName ?? provider.instanceId} 비활성화됨` };
  }
  if (!provider.installed || provider.status === "error") {
    return {
      healthy: false,
      reason: `${provider.displayName ?? provider.instanceId} 설치/상태 오류`,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return { healthy: false, reason: `${provider.displayName ?? provider.instanceId} 미인증` };
  }
  if (rateLimitedIds.has(provider.instanceId)) {
    return {
      healthy: false,
      reason: `${provider.displayName ?? provider.instanceId} 최근 429/쿼터 제한`,
    };
  }
  const primaryPct = provider.usage?.primary?.usedPercent;
  const secondaryPct = provider.usage?.secondary?.usedPercent;
  if (
    (primaryPct !== undefined && primaryPct >= 99) ||
    (secondaryPct !== undefined && secondaryPct >= 99)
  ) {
    return {
      healthy: false,
      reason: `${provider.displayName ?? provider.instanceId} 쿼터 소진(>=99%)`,
    };
  }
  return { healthy: true };
}

function parseCheckerDecision(raw: string): {
  readonly decision: "approve" | "block" | "hold";
  readonly evidence: string;
} {
  const parsed = extractStructuredTagJson(raw, "t3_checker_verdict");
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const dec = obj.decision;
    const ev = typeof obj.evidence === "string" ? obj.evidence.trim() : "";
    if (dec === "approve" || dec === "block" || dec === "hold") {
      return { decision: dec, evidence: ev || raw.trim().slice(0, 1200) };
    }
  }
  const upper = raw.toUpperCase();
  if (upper.includes("REJECT") || upper.includes("BLOCK")) {
    return { decision: "block", evidence: raw.trim().slice(0, 1200) };
  }
  if (upper.includes("CONFIRM") || upper.includes("APPROVE")) {
    return { decision: "approve", evidence: raw.trim().slice(0, 1200) };
  }
  return { decision: "hold", evidence: raw.trim().slice(0, 1200) || "판정 형식 미확인" };
}

export const CouncilOrchestratorLive = Layer.effect(
  CouncilOrchestratorService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const agentExecutor = yield* WorkspaceAgentExecutor;
    const orchestrationEngineOpt = yield* Effect.serviceOption(OrchestrationEngineService);
    const workerEngineOpt = yield* Effect.serviceOption(WorkerEngineService);
    const worktreeProvisionOpt = yield* Effect.serviceOption(WorktreeProvisionService);
    const gitWorkflowOpt = yield* Effect.serviceOption(GitWorkflowService);

    const executeCouncilWorker = (args: {
      readonly councilId: string;
      readonly threadId: ThreadId;
      readonly role: string;
      readonly dispatchId: string;
      readonly cwd: string;
      readonly specSummary: string;
      readonly worktree?:
        | { readonly worktreePath: string; readonly worktreeBranch: string | null }
        | undefined;
      readonly executionInput: WorkspaceAgentExecutionInput;
    }): Effect.Effect<string, WorkspaceAgentExecutionError> => {
      if (Option.isNone(workerEngineOpt)) {
        return agentExecutor.execute(args.executionInput);
      }
      return workerEngineOpt.value
        .runAndCollect(
          {
            runId: args.councilId,
            threadId: args.threadId,
            callerKind: "council",
            role: args.role,
            targetInstanceId: args.executionInput.modelSelection.instanceId,
            targetModel: args.executionInput.modelSelection.model,
            specText: args.specSummary.slice(0, 4_000),
            cwd: args.cwd,
            worktreeMode: args.worktree ? "isolated" : "current",
          },
          {
            dispatchId: args.dispatchId,
            allowDuplicate: true,
            maxRunningPerThread: 32,
            ...(args.worktree ? { externalWorktree: args.worktree } : {}),
            runner: (req) =>
              agentExecutor
                .execute({
                  ...args.executionInput,
                  onRuntimeEvent: (event) => {
                    const base = args.executionInput.onRuntimeEvent
                      ? args.executionInput.onRuntimeEvent(event)
                      : Effect.void;
                    return base.pipe(Effect.andThen(req.onActivity(event.type)), Effect.ignore);
                  },
                  onPartialOutput: (fullOutput) => {
                    args.executionInput.onPartialOutput?.(fullOutput);
                    req.onPartialOutput?.(fullOutput);
                  },
                })
                .pipe(
                  Effect.map((resultText) => ({
                    resultText,
                    summary: resultText.slice(0, 400),
                    exitCode: 0,
                  })),
                  Effect.mapError((err) => {
                    recordUnavailableModelFromError({
                      providerInstanceId: args.executionInput.modelSelection.instanceId,
                      model: args.executionInput.modelSelection.model,
                      errorMessage: err.message,
                    });
                    return new WorkerEngineError({
                      code: err.interrupted && !err.timedOut ? "conflict" : "invalid_state",
                      message: err.message,
                      details: {
                        interrupted: err.interrupted === true && !err.timedOut,
                        ...(err.timedOut ? { timedOut: true } : {}),
                        ...(err.partialOutput ? { partialOutput: err.partialOutput } : {}),
                      },
                    });
                  }),
                ),
          },
        )
        .pipe(
          Effect.map((res) => res.resultText),
          Effect.mapError(
            (err) =>
              new WorkspaceAgentExecutionError({
                message: err.message,
                ...(err.details?.interrupted === true ? { interrupted: true } : {}),
              }),
          ),
        );
    };

    // Council seats, delegated workers, and independent checkers inherit the owning thread's
    // runtimeMode and interactionMode directly (preferring explicit overrides from the chat
    // composer, then the single-thread projection query, then the shell snapshot fallback).
    // Never hardcode `interactionMode: "plan"` or downgrade full-access threads to approval prompts.
    const resolveThreadModes = (
      threadId: ThreadId,
      overrides?: {
        readonly runtimeMode?: RuntimeMode;
        readonly interactionMode?: ProviderInteractionMode;
      },
    ): Effect.Effect<{
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }> => {
      if (overrides?.runtimeMode !== undefined && overrides?.interactionMode !== undefined) {
        return Effect.succeed({
          runtimeMode: overrides.runtimeMode,
          interactionMode: overrides.interactionMode,
        });
      }
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
          runtimeMode: overrides?.runtimeMode ?? resolved?.runtimeMode ?? "approval-required",
          interactionMode: overrides?.interactionMode ?? resolved?.interactionMode ?? "default",
        };
      });
    };

    const store = makeCouncilStore(sql);

    // Clean up any council sessions interrupted by a previous server shutdown/restart
    yield* store.closeStaleCouncilSessions().pipe(
      Effect.tap((closed) =>
        closed > 0
          ? Effect.logInfo("Marked stale council sessions as INTERRUPTED_BY_RESTART", { closed })
          : Effect.void,
      ),
      Effect.catch(() => Effect.void),
    );

    const orchestrator = yield* makeCouncilOrchestrator({
      store,
      sqlClient: sql,
      resolveContext: ({ threadId, projectId }) =>
        Effect.gen(function* () {
          const [settings, providers, shell] = yield* Effect.all([
            serverSettings.getSettings.pipe(
              Effect.mapError(
                (err) =>
                  new CouncilError({
                    code: "EXECUTION_FAILED",
                    message: `서버 설정 조회 실패: ${err.message}`,
                  }),
              ),
            ),
            providerRegistry.getProviders,
            projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.mapError(
                (err) =>
                  new CouncilError({
                    code: "EXECUTION_FAILED",
                    message: `워크스페이스 스냅샷 조회 실패: ${err.message}`,
                  }),
              ),
            ),
          ]);

          const sinceIso = new Date(Date.now() - 15 * 60_000).toISOString();
          const rateLimitedList = projectionSnapshotQuery.getRateLimitedAccountIds
            ? yield* projectionSnapshotQuery
                .getRateLimitedAccountIds(sinceIso)
                .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])))
            : [];
          const rateLimitedIds = new Set(rateLimitedList);

          const project = shell.projects.find((p) => p.id === projectId);
          const thread = shell.threads.find((t) => t.id === threadId);
          if (!project) {
            return yield* Effect.fail(
              new CouncilError({
                code: "NOT_FOUND",
                message: `프로젝트 '${projectId}'을(를) 찾을 수 없습니다.`,
              }),
            );
          }

          const providerById = new Map(providers.map((p) => [p.instanceId, p]));

          // Determine Chair model from active thread's modelSelection or first healthy provider
          let chairModel: ModelTargetRef | null = null;
          if (thread?.modelSelection) {
            const p = providerById.get(thread.modelSelection.instanceId);
            chairModel = {
              providerInstanceId: thread.modelSelection.instanceId,
              driverId: (p?.driver ?? thread.modelSelection.instanceId) as ProviderDriverKind,
              modelId: thread.modelSelection.model,
              displayName: p?.displayName
                ? `${p.displayName} · ${thread.modelSelection.model}`
                : `${thread.modelSelection.instanceId} · ${thread.modelSelection.model}`,
            };
          } else {
            const firstHealthy = providers.find(
              (p) =>
                assessProviderSnapshotHealth(p, rateLimitedIds).healthy &&
                defaultModelForProvider(p),
            );
            const fallbackModelSlug = firstHealthy ? defaultModelForProvider(firstHealthy) : null;
            if (firstHealthy && fallbackModelSlug) {
              chairModel = {
                providerInstanceId: firstHealthy.instanceId,
                driverId: firstHealthy.driver,
                modelId: fallbackModelSlug,
                displayName: firstHealthy.displayName
                  ? `${firstHealthy.displayName} · ${fallbackModelSlug}`
                  : `${firstHealthy.instanceId} · ${fallbackModelSlug}`,
              };
            }
          }

          if (!chairModel) {
            return yield* Effect.fail(
              new CouncilError({
                code: "NO_AVAILABLE_MODELS",
                message: "의장 역할을 맡을 활성 모델이 없습니다. 제공자 연결 상태를 확인하세요.",
              }),
            );
          }

          const team = resolveSubordinateTeam(settings, threadId);
          const providerMetaMap: Record<
            string,
            {
              readonly driver?: ProviderDriverKind;
              readonly displayName?: string;
              readonly enabled?: boolean;
            }
          > = {};
          for (const p of providers) {
            providerMetaMap[p.instanceId] = {
              driver: p.driver,
              ...(p.displayName ? { displayName: p.displayName } : {}),
              enabled: p.enabled,
            };
          }

          const configuredSubordinates = buildSubordinateSlotsFromTeam({
            members: team.members,
            providerInstances: providerMetaMap,
            driverSupportsTemperature: (driverId) =>
              driverId === "opencode" || driverId === "ollama" || driverId === "custom",
          });

          const fallbackCandidates = providers.flatMap((p) => {
            const modelSlug = defaultModelForProvider(p);
            if (!modelSlug) return [];
            return [
              {
                target: {
                  providerInstanceId: p.instanceId as ProviderInstanceId,
                  driverId: p.driver,
                  modelId: modelSlug,
                  displayName: p.displayName
                    ? `${p.displayName} · ${modelSlug}`
                    : `${p.instanceId} · ${modelSlug}`,
                },
                supportsTemperature: p.driver === "opencode" || p.driver === "ollama",
              },
            ];
          });

          const workspaceSummary = [
            `프로젝트: ${project.title} (${project.workspaceRoot})`,
            ...(thread ? [`대화 제목: ${thread.title}`] : []),
            `활성 전역 하위 팀 슬롯: ${configuredSubordinates.filter((s) => s.enabled).length}개`,
          ].join("\n");

          // Pre-flight availability & Antseed peer/policy check (read-only metadata + cooldown, zero paid probes).
          const settingsInstances = (settings.providerInstances ?? {}) as Record<
            string,
            { readonly apiConnection?: { readonly providerId?: string; readonly baseUrl?: string } }
          >;
          const preflightUnavailable = new Map<string, string>();
          const targetsToProbe = [
            ...configuredSubordinates.filter((s) => s.enabled).map((s) => s.target),
            ...fallbackCandidates.map((c) => c.target),
          ];
          const seenProbeKeys = new Set<string>();
          for (const target of targetsToProbe) {
            const probeKey = `${target.providerInstanceId}::${target.modelId}`;
            if (seenProbeKeys.has(probeKey)) continue;
            seenProbeKeys.add(probeKey);
            const instCfg = settingsInstances[target.providerInstanceId];
            const probeResult = yield* Effect.promise(() =>
              probeModelAvailabilityBeforeDispatch({
                providerInstanceId: target.providerInstanceId,
                model: target.modelId,
                apiProviderId: instCfg?.apiConnection?.providerId,
                baseUrl: instCfg?.apiConnection?.baseUrl,
              }),
            );
            if (!probeResult.available && probeResult.reason) {
              preflightUnavailable.set(probeKey, probeResult.reason);
            }
          }

          return {
            projectRoot: thread?.worktreePath ?? project.workspaceRoot,
            chairModel,
            configuredSubordinates,
            fallbackCandidates,
            assessTargetHealth: (target) => {
              const probeKey = `${target.providerInstanceId}::${target.modelId}`;
              const preflightReason =
                preflightUnavailable.get(probeKey) ??
                getUnavailableModelReason(target.providerInstanceId, target.modelId);
              if (preflightReason) {
                return {
                  healthy: false,
                  reason: preflightReason,
                  preserveSlotOnUnavailable: true,
                };
              }
              return assessProviderSnapshotHealth(
                providerById.get(target.providerInstanceId),
                rateLimitedIds,
              );
            },
            workspaceSummary,
            ...(thread
              ? { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode }
              : {}),
          };
        }),

      runSeatTurn: ({
        councilId,
        threadId,
        projectRoot,
        seat,
        roundNum,
        retryAttempt,
        prompt,
        runtimeMode: overrideRuntimeMode,
        interactionMode: overrideInteractionMode,
        onPartialOutput,
        onActivity,
      }) =>
        Effect.flatMap(
          resolveThreadModes(threadId, {
            ...(overrideRuntimeMode ? { runtimeMode: overrideRuntimeMode } : {}),
            ...(overrideInteractionMode ? { interactionMode: overrideInteractionMode } : {}),
          }),
          (modes) => {
            const retrySuffix = retryAttempt && retryAttempt > 0 ? `:retry${retryAttempt}` : "";
            const seatExecId = `${councilId}:r${roundNum}:${seat.seatId}${retrySuffix}`;
            return executeCouncilWorker({
              councilId,
              threadId,
              role: `council_${seat.assignedRole.toLowerCase()}`,
              dispatchId: seatExecId,
              cwd: projectRoot,
              specSummary: `다자간 위원회 R${roundNum} · ${seat.assignedRole}`,
              executionInput: {
                orchestraPhase: "meeting",
                usageWorkId: seatExecId,
                execution: {
                  executionId: ProviderExecutionId.make(seatExecId),
                  ownerThreadId: threadId,
                  runId: WorkspaceCollaborationRunId.make(councilId),
                  nodeId: WorkspaceTaskNodeId.make(
                    `r${roundNum}_${seat.seatId}${retryAttempt && retryAttempt > 0 ? `_retry${retryAttempt}` : ""}`
                      .replace(/[^A-Za-z0-9._-]/g, "_")
                      .slice(0, 64),
                  ),
                  attempt: (retryAttempt ?? 0) + 1,
                },
                modelSelection: {
                  instanceId: seat.targetModel.providerInstanceId,
                  model: seat.targetModel.modelId,
                },
                runtimeMode: modes.runtimeMode,
                interactionMode: modes.interactionMode,
                cwd: projectRoot,
                prompt,
                title: `다자간 위원회 R${roundNum} · ${seat.assignedRole}`,
                displayName: seat.targetModel.displayName,
                role: "reviewer",
                kind: "validation",
                startedAt: new Date().toISOString(),
                ...(onPartialOutput ? { onPartialOutput } : {}),
                ...(onActivity
                  ? {
                      onRuntimeEvent: () =>
                        Effect.sync(() => {
                          onActivity();
                        }),
                    }
                  : {}),
              },
            });
          },
        ),

      ...(Option.isSome(orchestrationEngineOpt)
        ? {
            publishTimelineReport: ({ councilId, threadId, markdown }) =>
              Effect.gen(function* () {
                const existing =
                  typeof projectionSnapshotQuery.getThreadRuntimeContext === "function"
                    ? yield* projectionSnapshotQuery
                        .getThreadRuntimeContext(threadId)
                        .pipe(Effect.catchCause(() => Effect.succeed(Option.none())))
                    : Option.none();
                const messageId = MessageId.make(`council-report:${councilId}`);
                if (
                  Option.isSome(existing) &&
                  existing.value.messages.some((m) => m.id === messageId && !m.streaming)
                ) {
                  return;
                }
                const createdAt = new Date().toISOString();
                yield* orchestrationEngineOpt.value.dispatch({
                  type: "thread.message.assistant.delta",
                  commandId: CommandId.make(`council-report:${councilId}:text`),
                  threadId,
                  messageId,
                  delta: markdown,
                  createdAt,
                });
                yield* orchestrationEngineOpt.value.dispatch({
                  type: "thread.message.assistant.complete",
                  commandId: CommandId.make(`council-report:${councilId}:complete`),
                  threadId,
                  messageId,
                  createdAt,
                });
              }),
          }
        : {}),

      ...(Option.isSome(workerEngineOpt)
        ? {
            abortCouncilWorkers: ({ councilId, reason }) =>
              Effect.gen(function* () {
                const status = yield* workerEngineOpt.value
                  .status({ runId: councilId })
                  .pipe(
                    Effect.catch(() =>
                      Effect.succeed({ tasks: [], activeDispatches: [], pendingGates: [] }),
                    ),
                  );
                for (const d of status.activeDispatches) {
                  yield* workerEngineOpt.value
                    .stop({ dispatchId: d.dispatchId, reason })
                    .pipe(Effect.catch(() => Effect.void));
                }
              }),
            abortSeatDispatch: ({ councilId, seatId, roundNum, retryAttempt, reason }) =>
              Effect.gen(function* () {
                const retrySuffix = retryAttempt > 0 ? `:retry${retryAttempt}` : "";
                const targetDispatchId = `${councilId}:r${roundNum}:${seatId}${retrySuffix}`;
                yield* workerEngineOpt.value
                  .stop({ dispatchId: targetDispatchId, reason })
                  .pipe(Effect.catch(() => Effect.void));
              }),
          }
        : {}),

      ...(Option.isSome(worktreeProvisionOpt) && Option.isSome(gitWorkflowOpt)
        ? {
            provisionWorktree: ({ projectCwd, branch }) =>
              Effect.gen(function* () {
                const status = yield* gitWorkflowOpt.value.status({ cwd: projectCwd });
                const baseBranch = status.refName ?? "HEAD";
                const res = yield* worktreeProvisionOpt.value.provision({
                  projectCwd,
                  baseBranch,
                  branch,
                  reattachExisting: true,
                });
                return { worktreePath: res.worktreePath, refName: res.refName };
              }),
          }
        : {}),

      launchWorker: (args) =>
        Effect.gen(function* () {
          const workerModes = yield* resolveThreadModes(args.threadId);
          const delegationId =
            args.delegationId ?? `cdel_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const resolvedWorktreePath = args.worktreePath ?? args.pinnedSpec.worktreePath ?? null;
          const resolvedWorktreeBranch =
            args.worktreeBranch ?? args.pinnedSpec.worktreeBranch ?? null;
          const outputText = yield* executeCouncilWorker({
            councilId: args.pinnedSpec.councilId,
            threadId: args.threadId,
            role: "worker",
            dispatchId: delegationId,
            cwd: args.cwd,
            specSummary: `PinnedSpec 실행: ${args.pinnedSpec.titleKo}\n${args.instruction.slice(0, 2_000)}`,
            ...(resolvedWorktreePath
              ? {
                  worktree: {
                    worktreePath: resolvedWorktreePath,
                    worktreeBranch: resolvedWorktreeBranch,
                  },
                }
              : {}),
            executionInput: {
              // Council PinnedSpec workers are NOT rows in `projection_workspace_collaboration_runs`,
              // so leave `orchestraPhase` unset (same as `workspace_delegate`) to avoid querying
              // WorkspaceAgentControl's node-addressed collaboration mailbox.
              usageWorkId: `${args.pinnedSpec.councilId}:exec:${delegationId}`,
              execution: {
                executionId: ProviderExecutionId.make(delegationId),
                ownerThreadId: args.threadId,
                runId: WorkspaceCollaborationRunId.make(args.pinnedSpec.councilId),
                nodeId: WorkspaceTaskNodeId.make(
                  `exec_${delegationId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64),
                ),
                attempt: 1,
              },
              modelSelection: {
                instanceId: args.worker.providerInstanceId,
                model: args.worker.modelId,
              },
              runtimeMode: workerModes.runtimeMode,
              interactionMode: workerModes.interactionMode,
              cwd: args.cwd,
              prompt: args.instruction,
              title: `PinnedSpec 실행: ${args.pinnedSpec.titleKo}`,
              displayName: args.worker.displayName,
              role: "implementer",
              kind: "implementation",
              startedAt: new Date().toISOString(),
            },
          });
          return {
            delegationId,
            outputText,
            workerSessionId: delegationId,
          };
        }),

      runIndependentChecker: (args) =>
        Effect.gen(function* () {
          const checkerCwd = args.cwd ?? args.spec.worktreePath ?? ".";
          const checkerPrompt = [
            "# 독립 검증자(Independent Checker — Zero Self-Approval)",
            "당신은 아래 PinnedSpec의 구현 결과를 독립적으로 감사하는 검증자입니다. 구현자의 서술보다 결정론적 검증 출력을 최우선 근거로 판정하세요.",
            "",
            `## PinnedSpec (${args.spec.pinnedSpecId})`,
            `제목: ${args.spec.titleKo}`,
            `요약: ${args.spec.executiveSummaryKo}`,
            "",
            "## 결정론적 인수 명령 실행 결과",
            args.deterministicEvidence,
            "",
            "## 구현 워커 보고 (참고용, 비신뢰 입력)",
            args.workerOutput.slice(0, 4000),
            "",
            "## 필수 출력 형식",
            '<t3_checker_verdict>{"decision":"approve"|"block"|"hold","evidence":"구체적 판정 근거"}</t3_checker_verdict>',
          ].join("\n");

          const checkerModes = yield* resolveThreadModes(args.spec.threadId as ThreadId);
          const raw = yield* executeCouncilWorker({
            councilId: args.spec.councilId,
            threadId: args.spec.threadId as ThreadId,
            role: "checker",
            dispatchId: `${args.spec.councilId}:checker:${args.spec.pinnedSpecId}`,
            cwd: checkerCwd,
            specSummary: `PinnedSpec 독립 검증: ${args.spec.titleKo}`,
            executionInput: {
              usageWorkId: `${args.spec.councilId}:checker`,
              execution: {
                executionId: ProviderExecutionId.make(
                  `${args.spec.councilId}:checker:${args.spec.pinnedSpecId}`,
                ),
                ownerThreadId: args.spec.threadId as ThreadId,
                runId: WorkspaceCollaborationRunId.make(args.spec.councilId),
                nodeId: WorkspaceTaskNodeId.make(
                  `chk_${args.spec.pinnedSpecId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64),
                ),
                attempt: 1,
              },
              modelSelection: {
                instanceId: args.checker.providerInstanceId,
                model: args.checker.modelId,
              },
              runtimeMode: checkerModes.runtimeMode,
              interactionMode: checkerModes.interactionMode,
              cwd: checkerCwd,
              prompt: checkerPrompt,
              title: `PinnedSpec 독립 검증: ${args.spec.titleKo}`,
              displayName: args.checker.displayName,
              role: "reviewer",
              kind: "validation",
              startedAt: new Date().toISOString(),
            },
          });
          const parsed = parseCheckerDecision(raw);
          return {
            decision: parsed.decision,
            evidence: parsed.evidence,
            checkerSessionId: `chk_${args.spec.pinnedSpecId}`,
          };
        }),
    });

    return orchestrator;
  }),
);
