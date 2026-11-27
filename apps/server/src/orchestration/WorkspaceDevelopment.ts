import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  DevelopmentBindingId,
  DevelopmentWorkspaceId,
  EventId,
  MessageId,
  ProviderExecutionId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  WorkspaceDevelopmentError,
  WorkspaceDevelopmentDefinition,
  type DevelopmentSessionBinding,
  type DevelopmentTask,
  type DevelopmentWorkspace,
  type ProjectId,
  type WorkspaceDevelopmentAction,
  type WorkspaceDevelopmentConfigure,
  type WorkspaceDevelopmentDirectInput,
  type WorkspaceDevelopmentReturnControl,
  type WorkspaceDevelopmentState,
  type WorkspaceDevelopmentGoalInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { WorktreeProvisionService } from "../git/WorktreeProvisionService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { WorkspaceDevelopmentStore } from "../persistence/WorkspaceDevelopmentStore.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  WorkspaceAgentExecutionError,
} from "./Services/WorkspaceAgentExecutor.ts";
import { WorkspaceDevelopmentGit } from "./WorkspaceDevelopmentGit.ts";
import {
  developmentDispatchBarrier,
  developmentTaskMayRun,
  developmentVerificationBarrier,
  sameDevelopmentModel,
  supersedeDevelopmentTasks,
} from "./workspaceDevelopmentPolicy.ts";
import {
  MAIN_DEVELOPMENT_INSTRUCTIONS,
  ARCHITECT_DEVELOPMENT_INSTRUCTIONS,
  ownerDevelopmentInstructions,
} from "./workspaceDevelopmentRoles.ts";
import { redactConversationRagSensitiveData } from "./workspaceConversationRag.ts";
import {
  developmentGoalElapsed,
  developmentGoalFingerprint,
  developmentGoalInstructions,
  developmentGoalLimit,
  developmentGoalRepeatedFailure,
  developmentMainCompletionConfirmed,
} from "./workspaceDevelopmentGoal.ts";
import {
  developmentGoalWorkId,
  developmentTokenBudgetLimit,
  developmentUsageDay,
  developmentUsageSummary,
} from "./workspaceDevelopmentUsage.ts";
import { formatAttachmentDocumentMatches } from "../documents/attachmentDocumentRag.ts";
import {
  classifyDevelopmentFailure,
  developmentRecoveryBarrier,
} from "./workspaceDevelopmentRecovery.ts";

export class WorkspaceDevelopment extends Context.Service<
  WorkspaceDevelopment,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<WorkspaceDevelopmentState | null, WorkspaceDevelopmentError>;
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<
      { readonly state: WorkspaceDevelopmentState | null },
      WorkspaceDevelopmentError
    >;
    readonly configure: (
      input: WorkspaceDevelopmentConfigure,
    ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>;
    readonly directInput: (
      input: WorkspaceDevelopmentDirectInput,
    ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>;
    readonly returnControl: (
      input: WorkspaceDevelopmentReturnControl,
    ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>;
    readonly goal: (
      input: WorkspaceDevelopmentGoalInput,
    ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>;
    readonly invoke: (
      scope: McpInvocationScope,
      input: WorkspaceDevelopmentAction,
    ) => Effect.Effect<string, WorkspaceDevelopmentError>;
    readonly prepareMainInput: (
      threadId: ThreadId,
      text: string,
      messageId?: MessageId,
    ) => Effect.Effect<string, WorkspaceDevelopmentError>;
    readonly workflowContext: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<string, WorkspaceDevelopmentError>;
  }
>()("t3/orchestration/WorkspaceDevelopment") {}

const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isDevelopmentError = Schema.is(WorkspaceDevelopmentError);
const failure = (cause: unknown) =>
  isDevelopmentError(cause)
    ? cause
    : new WorkspaceDevelopmentError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
const id = () => CommandId.make(`development:${NodeCrypto.randomUUID()}`);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const nativeId = (cursor: unknown): string | null => {
  if (typeof cursor !== "object" || cursor === null) return null;
  if ("resume" in cursor && typeof cursor.resume === "string") return cursor.resume;
  if ("threadId" in cursor && typeof cursor.threadId === "string") return cursor.threadId;
  if ("sessionId" in cursor && typeof cursor.sessionId === "string") return cursor.sessionId;
  return null;
};
const summary = (state: WorkspaceDevelopmentState) =>
  stringify({
    revision: state.revision,
    policyRevision: state.policyRevision,
    goal: state.goal ?? null,
    architectReview: state.architectReview ?? null,
    mainObservedRevision: state.mainObservedRevision,
    mainActedRevision: state.mainActedRevision,
    ownerModels: state.ownerModels,
    workspaces: state.workspaces,
    bindings: state.bindings.map(({ id, workspaceId, role, nativeSessionId, model, cwd }) => ({
      id,
      workspaceId,
      role,
      nativeSessionId,
      model,
      cwd,
    })),
    tasks: state.tasks
      .slice(-30)
      .map(({ output, ...task }) => ({ ...task, summary: output.slice(-1_500) })),
    verifications: state.verifications.slice(-15),
    integrations: state.integrations.slice(-10),
    usage: state.usage ?? null,
    maxDailyTokens: state.maxDailyTokens ?? null,
  });
const requireWorkspace = (
  state: WorkspaceDevelopmentState,
  workspaceId: DevelopmentWorkspaceId | undefined,
) => state.workspaces.find((workspace) => workspace.id === workspaceId);

export const layer = Layer.effect(
  WorkspaceDevelopment,
  Effect.gen(function* () {
    const store = yield* WorkspaceDevelopmentStore;
    const git = yield* WorkspaceDevelopmentGit;
    const executor = yield* WorkspaceAgentExecutor;
    const provider = yield* ProviderService;
    const runtimes = yield* ProviderSessionRuntimeRepository;
    const queries = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const provision = yield* WorktreeProvisionService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serviceScope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const integrationLock = yield* Semaphore.make(1);
    const topologyLock = yield* Semaphore.make(1);
    const changed = yield* PubSub.unbounded<ProjectId>();
    const kicks = yield* Queue.unbounded<void>();
    const active = new Map<string, Fiber.Fiber<void, never>>();
    const auxiliaryRuns = new Set<string>();
    const waking = new Set<string>();
    const save = Effect.fn("WorkspaceDevelopment.save")(function* (
      projectId: ProjectId,
      commandId: CommandId,
      kind: string,
      source: "user" | "main" | "architect" | "runtime" | "git" | "verification",
      change: (current: WorkspaceDevelopmentState) => WorkspaceDevelopmentState,
      payload: unknown = {},
    ) {
      const state = yield* store.mutate(
        projectId,
        commandId,
        { kind, source, payload },
        (current) =>
          current
            ? Effect.succeed(change(current))
            : Effect.fail(
                new WorkspaceDevelopmentError({ message: "지속 작업실 설정이 없습니다." }),
              ),
      );
      yield* PubSub.publish(changed, projectId);
      return state;
    });
    const read = Effect.fn("WorkspaceDevelopment.read")(function* (projectId: ProjectId) {
      const state = yield* store.read(projectId);
      if (!state)
        return yield* new WorkspaceDevelopmentError({ message: "지속 작업실 설정이 없습니다." });
      return state;
    });
    const syncExecutionPolicy = Effect.fn("WorkspaceDevelopment.syncExecutionPolicy")(function* (
      state: WorkspaceDevelopmentState,
    ) {
      const main = yield* queries.getThreadRuntimeContext(state.conversationId);
      if (Option.isNone(main) || main.value.projectId !== state.projectId) return state;
      const { runtimeMode, interactionMode } = main.value;
      if (
        state.runtimeMode === runtimeMode &&
        (state.interactionMode ?? "default") === interactionMode
      )
        return state;
      return yield* save(
        state.projectId,
        id(),
        "policy.selection-synchronized",
        "user",
        (current) => ({ ...current, runtimeMode, interactionMode }),
        { runtimeMode, interactionMode },
      );
    }, Effect.mapError(failure));
    const withUsage = Effect.fn("WorkspaceDevelopment.withUsage")(function* (
      state: WorkspaceDevelopmentState,
    ) {
      const dailySince = developmentUsageDay(yield* now);
      const report =
        state.goal && queries.getThreadTokenUsage
          ? yield* queries.getThreadTokenUsage({
              threadId: state.conversationId,
              workId: `run:${developmentGoalWorkId(state.goal)}`,
            })
          : null;
      const daily = queries.getProjectTokenUsage
        ? yield* queries.getProjectTokenUsage({ projectId: state.projectId, since: dailySince })
        : null;
      return {
        ...state,
        usage: { goal: report ? developmentUsageSummary(report) : null, daily, dailySince },
      };
    }, Effect.mapError(failure));
    const stopAtBudget = Effect.fn("WorkspaceDevelopment.stopAtBudget")(function* (
      state: WorkspaceDevelopmentState,
    ) {
      const repeatedFailure =
        state.goal?.status === "active" ? developmentGoalRepeatedFailure(state) : null;
      if (!repeatedFailure && state.goal?.maxTokens == null && state.maxDailyTokens == null)
        return null;
      const measured = repeatedFailure ? null : yield* withUsage(state);
      const reason =
        repeatedFailure ??
        developmentTokenBudgetLimit({
          goal: measured!.usage.goal,
          daily: measured!.usage.daily,
          maxTokens: state.goal?.maxTokens,
          maxDailyTokens: state.maxDailyTokens,
        });
      if (reason && state.goal?.status === "active") {
        const timestamp = yield* now;
        yield* save(
          state.projectId,
          id(),
          repeatedFailure ? "goal.repeated-failure" : "goal.token-limit-reached",
          "runtime",
          (current) =>
            current.goal?.id !== state.goal?.id || current.goal?.status !== "active"
              ? current
              : {
                  ...current,
                  goal: {
                    ...current.goal!,
                    status: "limited",
                    revision: current.goal!.revision + 1,
                    activatedAt: null,
                    activeMilliseconds: developmentGoalElapsed(current.goal!, timestamp),
                    lastSummary: reason,
                  },
                },
        );
      }
      return reason;
    });
    const projectRoot = Effect.fn("WorkspaceDevelopment.projectRoot")(function* (
      projectId: ProjectId,
    ) {
      const snapshot = yield* queries.getCommandReadModel();
      const project = snapshot.projects.find(
        (project) => project.id === projectId && project.deletedAt === null,
      );
      if (!project)
        return yield* new WorkspaceDevelopmentError({ message: "프로젝트를 찾지 못했습니다." });
      return project.workspaceRoot;
    }, Effect.mapError(failure));
    const roleText = Effect.fn("WorkspaceDevelopment.roleText")(function* (
      projectId: ProjectId,
      file: string,
      fallback: string,
    ) {
      const filename = path.join(yield* projectRoot(projectId), ".workspace", file);
      if (!(yield* fs.exists(filename))) return fallback;
      const content = (yield* fs.readFileString(filename)).trim();
      if (!content || content.length > 30_000)
        return yield* new WorkspaceDevelopmentError({
          message: "역할 지침은 1~30,000자여야 합니다.",
        });
      return content;
    }, Effect.mapError(failure));
    const ownerRoleText = Effect.fn("WorkspaceDevelopment.ownerRoleText")(function* (
      projectId: ProjectId,
      workspace: DevelopmentWorkspace,
    ) {
      return (yield* roleText(
        projectId,
        path.join("templates", "owner.md"),
        ownerDevelopmentInstructions(workspace.name, workspace.scope),
      ))
        .replaceAll("{{name}}", workspace.name)
        .replaceAll("{{scope}}", workspace.scope.join(", "));
    });
    const bindingIdentity = Effect.fn("WorkspaceDevelopment.bindingIdentity")(function* (
      binding: DevelopmentSessionBinding,
    ) {
      const info = yield* provider.getInstanceInfo(binding.model.instanceId);
      if (!info.enabled || !["codex", "claudeAgent", "opencode"].includes(String(info.driverKind)))
        return yield* new WorkspaceDevelopmentError({
          message: "지속 작업실에는 활성 Codex, Claude Code 또는 OpenCode API 연결이 필요합니다.",
        });
      if (binding.runtimeIdentity !== stringify(info.continuationIdentity))
        return yield* new WorkspaceDevelopmentError({
          message:
            "provider 계정 또는 런타임 연결이 바뀌었습니다. 이전 세션을 다른 연결로 재개하지 않습니다.",
        });
      return info;
    }, Effect.mapError(failure));
    const recordNative = Effect.fn("WorkspaceDevelopment.recordNative")(function* (
      projectId: ProjectId,
      binding: DevelopmentSessionBinding,
      cursor?: unknown,
    ) {
      const row = yield* runtimes.getByThreadId({ threadId: binding.sessionKey });
      const value =
        nativeId(cursor) ?? (Option.isSome(row) ? nativeId(row.value.resumeCursor) : null);
      if (value === null || value === binding.nativeSessionId) return;
      if (binding.nativeSessionId !== null && value !== binding.nativeSessionId)
        return yield* new WorkspaceDevelopmentError({
          message:
            "기존 Owner와 다른 native session이 반환되었습니다. 실행을 중단하고 binding을 확인해야 합니다.",
        });
      yield* save(projectId, id(), "binding.native-confirmed", "runtime", (state) => ({
        ...state,
        bindings: state.bindings.map((current) =>
          current.id === binding.id ? { ...current, nativeSessionId: value } : current,
        ),
      }));
    }, Effect.mapError(failure));
    const freshness = Effect.fn("WorkspaceDevelopment.freshness")(function* (projectId: ProjectId) {
      let state = yield* syncExecutionPolicy(yield* read(projectId));
      for (const workspace of state.workspaces) {
        if (!workspace.worktreePath || workspace.status !== "ready" || active.has(workspace.id))
          continue;
        const snapshot = yield* git.inspect(workspace.worktreePath);
        if (snapshot.fingerprint === workspace.observedFingerprint) continue;
        state = yield* save(projectId, id(), "workspace.external-change", "git", (current) => ({
          ...current,
          pendingMainNotification: true,
          workspaces: current.workspaces.map((entry) =>
            entry.id === workspace.id
              ? {
                  ...entry,
                  observedFingerprint: snapshot.fingerprint,
                  stateRevision: current.revision + 1,
                  control: "reconciling",
                  externalUnmanaged: true,
                  summaryPending: true,
                  lastSummary: `관리 실행 밖에서 Git 상태가 변경되었습니다. HEAD=${snapshot.sha}; clean=${snapshot.clean}`,
                }
              : entry,
          ),
        }));
      }
      return state;
    });
    const announce = Effect.fn("WorkspaceDevelopment.announce")(function* (
      state: WorkspaceDevelopmentState,
      commandId: CommandId,
      text: string,
    ) {
      const createdAt = yield* now;
      yield* engine.dispatch({
        type: "thread.activity.append",
        threadId: state.conversationId,
        commandId: CommandId.make(`${commandId}:activity`),
        createdAt,
        activity: {
          id: EventId.make(String(commandId)),
          kind: "workspace.development",
          tone: "info",
          summary: text,
          payload: { projectId: state.projectId, revision: state.revision },
          turnId: null,
          createdAt,
        },
      });
    }, Effect.mapError(failure));
    const taskUpdate = (
      projectId: ProjectId,
      taskId: string,
      patch: Partial<DevelopmentTask>,
      kind: string,
    ) =>
      save(projectId, id(), kind, "runtime", (state) => ({
        ...state,
        tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
      })).pipe(Effect.asVoid);
    const executeTask = Effect.fn("WorkspaceDevelopment.executeTask")(function* (
      projectId: ProjectId,
      task: DevelopmentTask,
    ) {
      const state = yield* syncExecutionPolicy(yield* read(projectId));
      const workspace = requireWorkspace(state, task.workspaceId);
      const binding = state.bindings.find((binding) => binding.id === task.bindingId);
      if (!workspace || !binding || !workspace.worktreePath) return;
      const run = Effect.gen(function* () {
        yield* bindingIdentity(binding);
        const base = yield* git.inspect(workspace.worktreePath!);
        yield* taskUpdate(projectId, task.id, { baseSha: base.sha }, "run.started");
        const hookError = (error: WorkspaceDevelopmentError) =>
          new WorkspaceAgentExecutionError({ message: error.message });
        const nativeMessageIds = new Set<string>();
        const documents = queries.searchWorkspaceRag
          ? formatAttachmentDocumentMatches(
              (yield* queries.searchWorkspaceRag({
                projectId,
                query: task.objective,
                attachmentsOnly: true,
                includeShared: false,
                includeLongTermMemory: false,
                limit: 12,
                maxChunksPerItem: 3,
              })).matches,
            )
          : "";
        const prompt = [
          yield* ownerRoleText(projectId, workspace),
          `관리 입력 출처: ${task.source}. 작업 ${task.id}, command ${task.commandId}, 요구 개정 ${task.requirementRevision}.`,
          `기준 SHA: ${base.sha}. 통합 결과를 반영할 때 사용자 미커밋 변경을 보존하세요.`,
          `최근 통합 결과: ${state.integrations.findLast((entry) => entry.status === "release-ready")?.resultSha ?? "없음"}. 다른 영역 변경은 최신 통합 커밋에서 확인하세요.`,
          task.objective,
          ...(task.recoveryStrategy
            ? [
                `복구 방법: ${task.recoveryStrategy}. 이전 실패 원문과 상태를 확인한 뒤 이 방법으로 진행하세요.`,
              ]
            : []),
          "완료조건:",
          ...task.acceptanceCriteria.map((value) => `- ${value}`),
          documents,
        ].join("\n");
        const output = yield* executor.execute({
          persistentSessionKey: binding.sessionKey,
          ...(task.goalId ? { usageWorkId: developmentGoalWorkId({ id: task.goalId }) } : {}),
          execution: {
            executionId: ProviderExecutionId.make(binding.sessionKey),
            ownerThreadId: state.conversationId,
            runId: WorkspaceCollaborationRunId.make(task.runId),
            nodeId: WorkspaceTaskNodeId.make(task.id),
            attempt: task.fencingGeneration,
          },
          modelSelection: binding.model,
          runtimeMode: state.runtimeMode,
          interactionMode: state.interactionMode ?? "default",
          cwd: workspace.worktreePath!,
          prompt,
          title: `${workspace.name} · ${task.source === "user-direct" ? "직접 지시" : "Main 배정"}`,
          instruction: task.objective,
          displayName: workspace.name,
          role: "implementer",
          kind: "implementation",
          startedAt: task.requestedAt,
          onSessionStarted: (session) =>
            Effect.gen(function* () {
              if (
                session.cwd !== binding.cwd ||
                session.providerInstanceId !== binding.model.instanceId ||
                (session.model !== undefined && session.model !== binding.model.model)
              )
                return yield* new WorkspaceDevelopmentError({
                  message: "재개한 Owner의 cwd/provider/model이 실제 binding과 다릅니다.",
                });
              yield* recordNative(projectId, binding, session.resumeCursor);
            }).pipe(Effect.mapError(hookError)),
          onSessionStopped: (confirmed) =>
            confirmed
              ? Effect.void
              : save(projectId, id(), "writer.stop-unconfirmed", "runtime", (current) => ({
                  ...current,
                  workspaces: current.workspaces.map((entry) =>
                    entry.id === workspace.id
                      ? {
                          ...entry,
                          control: "reconciling",
                          summaryPending: true,
                          externalUnmanaged: true,
                          error:
                            "세션 종료를 확인하지 못했습니다. 실제 실행 상태 확인 전 새 writer를 시작하지 않습니다.",
                        }
                      : entry,
                  ),
                })).pipe(Effect.asVoid, Effect.mapError(hookError)),
          onRuntimeEvent: (event) => {
            const messageId = event.providerRefs?.providerItemId;
            if (
              !messageId ||
              (event.type !== "item.started" && event.type !== "item.completed") ||
              nativeMessageIds.has(messageId)
            )
              return Effect.void;
            nativeMessageIds.add(messageId);
            return taskUpdate(
              projectId,
              task.id,
              { nativeMessageIds: [...nativeMessageIds] },
              "run.native-message-linked",
            ).pipe(Effect.mapError(hookError));
          },
          onBeforeSubmit: lock
            .withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* read(projectId);
                const current = latest.tasks.find((entry) => entry.id === task.id);
                if (
                  !current ||
                  current.status !== "running" ||
                  current.requirementRevision !==
                    requireWorkspace(latest, task.workspaceId)?.requirementRevision
                )
                  return yield* new WorkspaceDevelopmentError({
                    message: "입력 전 작업의 요구 또는 제어 상태가 변경되었습니다.",
                  });
                yield* taskUpdate(
                  projectId,
                  task.id,
                  { delivery: "submitting" },
                  "input.submitting",
                );
              }),
            )
            .pipe(Effect.mapError(hookError)),
          submitWithGate: (submit) =>
            lock
              .withPermits(1)(
                Effect.gen(function* () {
                  const latest = yield* read(projectId);
                  const current = latest.tasks.find((entry) => entry.id === task.id);
                  const currentWorkspace = requireWorkspace(latest, task.workspaceId);
                  if (
                    task.source === "main-dispatch" &&
                    task.goalId &&
                    latest.goal?.id === task.goalId &&
                    latest.goal.status !== "active"
                  )
                    return yield* new WorkspaceDevelopmentError({
                      message: "목표가 중단되어 새로운 자동 입력을 보류합니다.",
                    });
                  if (task.source === "main-dispatch" && (yield* stopAtBudget(latest)))
                    return yield* new WorkspaceDevelopmentError({
                      message: "토큰 예산으로 자동 입력을 보류합니다.",
                    });
                  if (
                    !current ||
                    current.status !== "running" ||
                    !currentWorkspace ||
                    current.requirementRevision !== currentWorkspace.requirementRevision ||
                    currentWorkspace.externalUnmanaged ||
                    (task.source === "main-dispatch" && currentWorkspace.control !== "managed")
                  )
                    return yield* new WorkspaceDevelopmentError({
                      message: "입력 수락 전에 요구 또는 제어권이 변경되었습니다.",
                    });
                  return yield* submit;
                }),
              )
              .pipe(
                Effect.mapError(
                  (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                ),
              ),
          onInputAccepted: (receipt) =>
            Effect.gen(function* () {
              if (receipt.nativeMessageId) nativeMessageIds.add(receipt.nativeMessageId);
              yield* taskUpdate(
                projectId,
                task.id,
                {
                  delivery: "accepted",
                  nativeTurnId: receipt.turnId,
                  nativeMessageIds: [...nativeMessageIds],
                },
                "input.accepted",
              );
              yield* recordNative(projectId, binding, receipt.resumeCursor);
            }).pipe(Effect.mapError(hookError)),
        });
        const snapshot = yield* git.inspect(workspace.worktreePath!);
        yield* recordNative(projectId, binding);
        const completedAt = yield* now;
        const safeOutput = redactConversationRagSensitiveData(output).content.slice(-6_000);
        yield* save(projectId, id(), "run.completed", "runtime", (current) => ({
          ...current,
          pendingMainNotification: true,
          tasks: current.tasks.map((entry) =>
            entry.id === task.id
              ? {
                  ...entry,
                  status: entry.status === "superseded" ? "superseded" : "completed",
                  completedAt,
                  output: safeOutput,
                  candidateSha: snapshot.clean ? snapshot.sha : null,
                }
              : entry,
          ),
          workspaces: current.workspaces.map((entry) =>
            entry.id === workspace.id
              ? {
                  ...entry,
                  observedFingerprint: snapshot.fingerprint,
                  stateRevision: current.revision + 1,
                  summaryPending: task.source === "user-direct" || entry.summaryPending,
                  control:
                    task.source === "user-direct"
                      ? entry.takeover
                        ? "human"
                        : "reconciling"
                      : entry.control,
                  lastSummary: `${task.id}: ${snapshot.clean ? snapshot.sha : "미커밋 변경 있음"}\n${safeOutput.slice(-2_000)}`,
                }
              : entry,
          ),
        }));
      });
      yield* run.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const completedAt = yield* now;
            const detail = Cause.hasInterruptsOnly(cause)
              ? "사용자 개입으로 실행을 중단했습니다."
              : failure(Cause.squash(cause)).message;
            const snapshot = yield* git.inspect(workspace.worktreePath!).pipe(Effect.option);
            yield* save(projectId, id(), "run.interrupted-or-failed", "runtime", (current) => ({
              ...current,
              pendingMainNotification: true,
              tasks: current.tasks.map((entry) =>
                entry.id !== task.id
                  ? entry
                  : {
                      ...entry,
                      status:
                        entry.status === "superseded"
                          ? "superseded"
                          : entry.delivery === "submitting"
                            ? "delivery_unknown"
                            : "failed",
                      delivery:
                        entry.delivery === "submitting" ? "delivery_unknown" : entry.delivery,
                      error: detail,
                      failureRecovery: classifyDevelopmentFailure(
                        detail,
                        entry.delivery,
                        Cause.hasInterruptsOnly(cause),
                      ),
                      ...(Option.isSome(snapshot)
                        ? { failureCodeFingerprint: snapshot.value.fingerprint }
                        : {}),
                      failureFingerprint: NodeCrypto.createHash("sha256")
                        .update(
                          JSON.stringify([
                            Option.isSome(snapshot) ? snapshot.value.fingerprint : null,
                            detail,
                            task.objective,
                          ]),
                        )
                        .digest("hex"),
                      completedAt,
                    },
              ),
              workspaces: current.workspaces.map((entry) =>
                entry.id !== workspace.id
                  ? entry
                  : {
                      ...entry,
                      ...(Option.isSome(snapshot)
                        ? { observedFingerprint: snapshot.value.fingerprint }
                        : {}),
                      stateRevision: current.revision + 1,
                      summaryPending: true,
                      control: entry.takeover ? "human" : "reconciling",
                      lastSummary: `${detail}\n복구: ${classifyDevelopmentFailure(detail, current.tasks.find((candidate) => candidate.id === task.id)?.delivery ?? task.delivery, Cause.hasInterruptsOnly(cause)).instruction}`,
                    },
              ),
            }));
          }).pipe(Effect.ignoreCause({ log: true })),
        ),
        Effect.ensuring(
          Effect.sync(() => active.delete(workspace.id)).pipe(
            Effect.andThen(Queue.offer(kicks, undefined)),
            Effect.asVoid,
          ),
        ),
      );
    });
    const pump = lock.withPermits(1)(
      Effect.gen(function* () {
        const states = yield* store.list;
        for (const state of states) {
          if (!state.enabled) continue;
          const tokenLimit = yield* stopAtBudget(state);
          const projectActive = state.workspaces.filter((workspace) =>
            active.has(workspace.id),
          ).length;
          let remaining = Math.min(
            state.maxParallelOwners - projectActive,
            3 - active.size - auxiliaryRuns.size,
          );
          for (const workspace of state.workspaces) {
            if (remaining <= 0) break;
            if (active.has(workspace.id) || auxiliaryRuns.has(workspace.id)) continue;
            const task = state.tasks.find(
              (task) =>
                task.workspaceId === workspace.id &&
                developmentTaskMayRun(workspace, task) &&
                !(tokenLimit && task.source === "main-dispatch") &&
                !(
                  state.goal &&
                  state.goal.status !== "active" &&
                  task.goalId === state.goal.id &&
                  task.source === "main-dispatch"
                ),
            );
            if (!task) continue;
            const generation =
              Math.max(
                state.bindings.find((binding) => binding.id === workspace.bindingId)
                  ?.runGeneration ?? 0,
                ...state.tasks
                  .filter((entry) => entry.workspaceId === workspace.id)
                  .map((entry) => entry.fencingGeneration),
              ) + 1;
            const running: DevelopmentTask = {
              ...task,
              status: "running",
              fencingGeneration: generation,
            };
            yield* save(state.projectId, id(), "run.leased", "runtime", (current) => ({
              ...current,
              tasks: current.tasks.map((entry) => (entry.id === task.id ? running : entry)),
              bindings: current.bindings.map((binding) =>
                binding.id === workspace.bindingId
                  ? { ...binding, runGeneration: generation }
                  : binding,
              ),
            }));
            const fiber = yield* executeTask(state.projectId, running).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.forkIn(serviceScope),
            );
            active.set(workspace.id, fiber);
            remaining--;
          }
        }
      }),
    );
    const wakeMain = Effect.fn("WorkspaceDevelopment.wakeMain")(
      function* () {
        for (let state of yield* store.list) {
          const goal = state.goal;
          if (
            !state.enabled ||
            waking.has(state.projectId) ||
            (goal
              ? goal.status !== "active" ||
                !!goal.pendingMessageId ||
                (goal.phase === "waiting" && !state.pendingMainNotification)
              : !state.pendingMainNotification)
          )
            continue;
          const thread = yield* queries.getThreadRuntimeContext(state.conversationId, {
            messages: true,
          });
          if (
            Option.isNone(thread) ||
            thread.value.session?.activeTurnId ||
            thread.value.session?.status === "starting" ||
            thread.value.latestTurn?.state === "running"
          )
            continue;
          state = yield* syncExecutionPolicy(state);
          const main = state.bindings.find((binding) => binding.role === "main");
          if (!main) continue;
          const timestamp = yield* now;
          const limit = goal && developmentGoalLimit(goal, timestamp, state);
          if (yield* stopAtBudget(state)) continue;
          if (goal && limit) {
            yield* save(state.projectId, id(), "goal.limit-reached", "runtime", (current) => ({
              ...current,
              goal: {
                ...current.goal!,
                status: "limited",
                revision: current.goal!.revision + 1,
                activatedAt: null,
                activeMilliseconds: developmentGoalElapsed(current.goal!, timestamp),
                lastSummary: limit,
              },
            }));
            continue;
          }
          waking.add(state.projectId);
          yield* Effect.gen(function* () {
            const commandId = CommandId.make(
              `development-wake:${state.projectId}:${state.revision}`,
            );
            if (goal)
              yield* save(
                state.projectId,
                id(),
                "goal.turn-reserved",
                "runtime",
                (current) => ({
                  ...current,
                  pendingMainNotification: false,
                  goal: {
                    ...current.goal!,
                    revision: current.goal!.revision + 1,
                    steps: current.goal!.steps + 1,
                    phase: "running",
                    pendingMessageId: String(commandId),
                    runSeen: false,
                    progressReported: false,
                  },
                }),
                { goalId: goal.id, messageId: String(commandId), step: goal.steps + 1 },
              );
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId,
              threadId: state.conversationId,
              inputOrigin: "automation",
              ...(goal
                ? {
                    usageContext: {
                      workId: developmentGoalWorkId(goal),
                      phase: "planning" as const,
                      nodeId: null,
                      attempt: goal.steps + 1,
                    },
                  }
                : {}),
              message: {
                messageId: MessageId.make(String(commandId)),
                role: "user",
                text: goal
                  ? "승인된 개발 목표의 다음 단계입니다. workspace_manage status로 최신 목표와 작업실 상태를 확인하고 개발을 이어가세요. 응답 종료 전에 goal-progress로 다음 진행 또는 대기·완료를 기록하세요."
                  : "작업실 변경 알림입니다. workspace_manage status로 최신 상태를 읽고 요구 변경과 결과의 영향을 확인한 뒤 조율을 이어가세요.",
                attachments: [],
              },
              modelSelection: main.model,
              runtimeMode: state.runtimeMode,
              interactionMode: state.interactionMode ?? "default",
              createdAt: yield* now,
            });
            yield* save(
              state.projectId,
              id(),
              "main.notification-submitted",
              "runtime",
              (current) => ({
                ...current,
                pendingMainNotification: goal
                  ? current.pendingMainNotification
                  : current.revision > state.revision,
              }),
            );
          }).pipe(
            Effect.catch((error) =>
              goal
                ? save(state.projectId, id(), "goal.delivery-unknown", "runtime", (current) => ({
                    ...current,
                    goal: {
                      ...current.goal!,
                      status: "blocked",
                      revision: current.goal!.revision + 1,
                      lastSummary: `Main 입력 수락 상태를 확인해야 합니다. 자동 재전송하지 않습니다: ${failure(error).message}`,
                    },
                  })).pipe(Effect.asVoid)
                : Effect.fail(error),
            ),
            Effect.ensuring(Effect.sync(() => waking.delete(state.projectId))),
          );
        }
      },
      (effect) => lock.withPermits(1)(effect),
      Effect.mapError(failure),
    );
    const recover = Effect.gen(function* () {
      for (let state of yield* store.list) {
        if (state.enabled) state = yield* syncExecutionPolicy(state);
        if (state.goal?.pendingMessageId) {
          const timestamp = yield* now;
          const main = state.bindings.find((binding) => binding.role === "main");
          const thread = yield* queries.getThreadRuntimeContext(state.conversationId, {
            messages: true,
          });
          const runtime = yield* runtimes.getByThreadId({ threadId: state.conversationId });
          const cursor = Option.isSome(runtime) ? nativeId(runtime.value.resumeCursor) : null;
          const confirmed =
            !!main &&
            Option.isSome(thread) &&
            developmentMainCompletionConfirmed(
              state.goal,
              thread.value,
              cursor,
              main.nativeSessionId,
            );
          if (confirmed) {
            yield* bindingIdentity(main!);
            yield* recordNative(state.projectId, main!);
          }
          yield* save(
            state.projectId,
            id(),
            "goal.restart-reconciled",
            "runtime",
            (current) => ({
              ...current,
              goal: {
                ...current.goal!,
                activeMilliseconds: developmentGoalElapsed(current.goal!, timestamp),
                status:
                  !confirmed && current.goal!.status === "active"
                    ? "blocked"
                    : current.goal!.status,
                revision: current.goal!.revision + 1,
                pendingMessageId: null,
                runSeen: false,
                activatedAt: confirmed && current.goal!.status === "active" ? timestamp : null,
                lastSummary: [
                  current.goal!.lastSummary,
                  confirmed
                    ? "저장된 입력·완료 응답·목표 진행 기록과 동일한 native session을 확인했습니다."
                    : `재시작 시 Main 입력 ${current.goal!.pendingMessageId}와 실행 상태를 확인하세요. 자동 재전송하지 않습니다.`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            }),
            { goalId: state.goal.id, messageId: state.goal.pendingMessageId },
          );
        }
        if (!state.tasks.some((task) => task.status === "running")) continue;
        yield* save(state.projectId, id(), "runtime.restart-reconciled", "runtime", (current) => ({
          ...current,
          pendingMainNotification: true,
          tasks: current.tasks.map((task) =>
            task.status !== "running"
              ? task
              : {
                  ...task,
                  status: "delivery_unknown",
                  delivery: "delivery_unknown",
                  error: "서비스 재시작: 수락·실행 상태를 확인하기 전 자동 재전송하지 않습니다.",
                },
          ),
          workspaces: current.workspaces.map((workspace) =>
            current.tasks.some(
              (task) => task.workspaceId === workspace.id && task.status === "running",
            )
              ? {
                  ...workspace,
                  control: workspace.takeover ? "human" : "reconciling",
                  summaryPending: true,
                }
              : workspace,
          ),
        }));
      }
    });
    // Old project-wide workspaces are historical records. New persistent work
    // runs through the conversation-scoped collaboration runner instead.
    for (const state of yield* store.list) {
      if (!state.enabled && state.goal?.status !== "active") continue;
      const timestamp = yield* now;
      yield* save(state.projectId, id(), "legacy-workspace.auto-stopped", "runtime", (current) => ({
        ...current,
        enabled: false,
        goal:
          current.goal?.status === "active"
            ? {
                ...current.goal,
                status: "paused",
                revision: current.goal.revision + 1,
                activeMilliseconds: developmentGoalElapsed(current.goal, timestamp),
                activatedAt: null,
                lastSummary: [
                  current.goal.lastSummary,
                  "기존 지속 작업실의 자동 진행을 중지했습니다. 기록은 보존됩니다.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            : current.goal,
      }));
    }
    yield* forkParked(
      recover.pipe(
        Effect.andThen(pump),
        Effect.andThen(wakeMain),
        Effect.ignoreCause({ log: true }),
      ),
    );
    yield* forkParked(
      Queue.take(kicks).pipe(
        Effect.andThen(pump),
        Effect.andThen(wakeMain),
        Effect.ignoreCause({ log: true }),
        Effect.forever,
      ),
    );
    yield* forkParked(
      engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.session-set" ||
            event.type === "thread.runtime-mode-set" ||
            event.type === "thread.interaction-mode-set" ||
            (event.type === "thread.activity-appended" &&
              ["context-window.updated", "orchestra.block"].includes(event.payload.activity.kind)),
        ),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (
              event.type === "thread.runtime-mode-set" ||
              event.type === "thread.interaction-mode-set"
            ) {
              const state = (yield* store.list).find(
                (state) => state.conversationId === event.payload.threadId,
              );
              if (state) yield* syncExecutionPolicy(state);
              return;
            }
            if (event.type === "thread.activity-appended") {
              const state = (yield* store.list).find(
                (state) => state.conversationId === event.payload.threadId,
              );
              if (state) yield* PubSub.publish(changed, state.projectId);
              yield* Queue.offer(kicks, undefined);
              return;
            }
            if (event.type !== "thread.session-set") return;
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const state = (yield* store.list).find(
                  (s) => s.conversationId === event.payload.threadId,
                );
                const goal = state?.goal;
                if (!state || !goal?.pendingMessageId) return;
                if (
                  event.payload.session.activeTurnId ||
                  event.payload.session.status === "starting"
                ) {
                  if (!goal.runSeen)
                    yield* save(
                      state.projectId,
                      id(),
                      "goal.run-observed",
                      "runtime",
                      (current) => ({
                        ...current,
                        goal: { ...current.goal!, runSeen: true },
                      }),
                    );
                } else if (goal.runSeen) {
                  const timestamp = yield* now;
                  yield* save(
                    state.projectId,
                    id(),
                    "goal.turn-finished",
                    "runtime",
                    (current) => ({
                      ...current,
                      goal: {
                        ...current.goal!,
                        ...(!current.goal!.progressReported && current.goal!.status === "active"
                          ? {
                              activeMilliseconds: developmentGoalElapsed(current.goal!, timestamp),
                              activatedAt: null,
                            }
                          : {}),
                        pendingMessageId: null,
                        runSeen: false,
                        status:
                          current.goal!.status === "active" && !current.goal!.progressReported
                            ? "blocked"
                            : current.goal!.status,
                        lastSummary: !current.goal!.progressReported
                          ? "Main 응답은 끝났지만 다음 진행 결과가 기록되지 않았습니다. 확인 후 재개하세요."
                          : current.goal!.lastSummary,
                      },
                    }),
                  );
                }
              }),
            );
            yield* Queue.offer(kicks, undefined);
          }).pipe(Effect.ignoreCause({ log: true })),
        ),
      ),
    );

    const goal = Effect.fn("WorkspaceDevelopment.goal")(function* (
      input: WorkspaceDevelopmentGoalInput,
    ) {
      const result = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* read(input.projectId);
          if (yield* store.hasCommand(input.projectId, input.commandId)) return state;
          if (!state.enabled || state.conversationId !== input.conversationId)
            return yield* new WorkspaceDevelopmentError({
              message: "활성 Main 대화에서 목표를 설정하세요.",
            });
          const current = state.goal;
          if (current && input.expectedGoalRevision !== current.revision)
            return yield* new WorkspaceDevelopmentError({
              message: "목표 상태가 변경되었습니다. 최신 상태에서 다시 실행하세요.",
            });
          const timestamp = yield* now;
          if (input.action === "start") {
            if (
              !input.objective ||
              !input.acceptanceCriteria?.length ||
              !input.maxSteps ||
              !input.maxMinutes ||
              !state.verificationCommands.length
            )
              return yield* new WorkspaceDevelopmentError({
                message: "목표, 완료조건, 진행 상한과 실제 검증 명령이 필요합니다.",
              });
            if (
              current?.pendingMessageId ||
              (current && !["complete", "cancelled"].includes(current.status))
            )
              return yield* new WorkspaceDevelopmentError({
                message: "기존 목표를 종료하고 실행이 정리된 뒤 새 목표를 시작하세요.",
              });
            const goalId = NodeCrypto.randomUUID();
            return yield* save(
              state.projectId,
              input.commandId,
              "goal.started",
              "user",
              (s) => ({
                ...s,
                goal: {
                  id: goalId,
                  revision: 1,
                  objective: input.objective!,
                  acceptanceCriteria: input.acceptanceCriteria!,
                  status: "active",
                  phase: "ready",
                  steps: 0,
                  maxSteps: input.maxSteps!,
                  maxMinutes: input.maxMinutes!,
                  maxTokens: input.maxTokens ?? null,
                  activeMilliseconds: 0,
                  activatedAt: timestamp,
                  pendingMessageId: null,
                  runSeen: false,
                  progressReported: false,
                  progressFingerprint: developmentGoalFingerprint(s),
                  noProgressSteps: 0,
                  lastSummary: "Main이 비면 승인된 목표를 시작합니다.",
                  integrationId: null,
                  initialIntegrationIds: s.integrations.map((i) => i.id),
                  startedAt: timestamp,
                },
              }),
              { ...input, goalId },
            );
          }
          if (!current || current.status === "complete" || current.status === "cancelled")
            return yield* new WorkspaceDevelopmentError({
              message: "제어할 미완료 목표가 없습니다.",
            });
          if (input.action === "resume" && current.status === "active") return state;
          if (input.action === "resume" && current.pendingMessageId)
            return yield* new WorkspaceDevelopmentError({
              message: "현재 Main 실행이 끝난 뒤 재개하세요.",
            });
          return yield* save(
            state.projectId,
            input.commandId,
            `goal.${input.action}`,
            "user",
            (s) => ({
              ...s,
              goal: {
                ...s.goal!,
                revision: s.goal!.revision + 1,
                status:
                  input.action === "pause"
                    ? "paused"
                    : input.action === "cancel"
                      ? "cancelled"
                      : "active",
                phase: input.action === "resume" ? "ready" : s.goal!.phase,
                ...(input.action === "resume" && input.maxTokens !== undefined
                  ? { maxTokens: input.maxTokens }
                  : {}),
                ...(input.action === "resume" && input.maxSteps !== undefined
                  ? { maxSteps: input.maxSteps }
                  : {}),
                ...(input.action === "resume" && input.maxMinutes !== undefined
                  ? { maxMinutes: input.maxMinutes }
                  : {}),
                activeMilliseconds: developmentGoalElapsed(s.goal!, timestamp),
                activatedAt: input.action === "resume" ? timestamp : null,
                ...(input.action === "resume" ? { lastResumedAt: timestamp } : {}),
                noProgressSteps: input.action === "resume" ? 0 : s.goal!.noProgressSteps,
                lastSummary:
                  input.action === "resume"
                    ? "최신 상태를 확인하고 자동 진행을 재개합니다."
                    : "자동 후속을 멈췄습니다. 이미 실행 중인 작업과 결과는 보존합니다.",
              },
              tasks:
                input.action === "cancel"
                  ? s.tasks.map((t) =>
                      t.goalId === current.id && t.status === "queued"
                        ? { ...t, status: "superseded" }
                        : t,
                    )
                  : s.tasks,
            }),
            { ...input, goalId: current.id },
          );
        }),
      );
      yield* announce(
        result,
        input.commandId,
        `개발 목표 ${result.goal?.status}: ${result.goal?.objective.slice(0, 240)}`,
      );
      yield* Queue.offer(kicks, undefined);
      return result;
    }, Effect.mapError(failure));

    const configure = Effect.fn("WorkspaceDevelopment.configure")(
      function* (input: WorkspaceDevelopmentConfigure) {
        const root = yield* projectRoot(input.projectId);
        const thread = yield* queries.getThreadRuntimeContext(input.conversationId, {
          messages: true,
        });
        if (
          Option.isNone(thread) ||
          thread.value.projectId !== input.projectId ||
          thread.value.worktreePath
        )
          return yield* new WorkspaceDevelopmentError({
            message: "프로젝트 통합 위치의 대화에서 지속 작업실을 설정해야 합니다.",
          });
        const models = [input.mainModel, ...input.ownerModels];
        for (const model of models) {
          const info = yield* provider.getInstanceInfo(model.instanceId);
          if (
            !info.enabled ||
            !["codex", "claudeAgent", "opencode"].includes(String(info.driverKind))
          )
            return yield* new WorkspaceDevelopmentError({
              message: "현재 기능의 모델은 Codex, Claude Code 또는 OpenCode 연결이어야 합니다.",
            });
        }
        const mainInfo = yield* provider.getInstanceInfo(input.mainModel.instanceId);
        const configuredAt = yield* now;
        const configured = yield* store.mutate(
          input.projectId,
          input.commandId,
          { kind: "policy.configured", source: "user", payload: { enabled: input.enabled } },
          (current) => {
            if (current && current.conversationId !== input.conversationId)
              return Effect.fail(
                new WorkspaceDevelopmentError({
                  message: "이미 다른 Main 대화에 연결되어 있습니다. 기존 대화를 사용하세요.",
                }),
              );
            if (
              current?.bindings.some(
                (binding) =>
                  binding.role === "owner" &&
                  !input.ownerModels.some((model) => sameDevelopmentModel(model, binding.model)),
              )
            )
              return Effect.fail(
                new WorkspaceDevelopmentError({
                  message:
                    "기존 Owner 모델을 허용 목록에서 제거하려면 먼저 세션 이관이 필요합니다.",
                }),
              );
            const previousMain = current?.bindings.find((binding) => binding.role === "main");
            if (
              input.enabled &&
              previousMain &&
              previousMain.runtimeIdentity !== stringify(mainInfo.continuationIdentity)
            )
              return Effect.fail(
                new WorkspaceDevelopmentError({
                  message:
                    "Main의 provider 또는 계정 연결 변경에는 명시적 세션 이관이 필요합니다. 기존 세션을 다른 런타임으로 재개하지 않습니다.",
                }),
              );
            return Effect.succeed({
              projectId: input.projectId,
              conversationId: input.conversationId,
              enabled: input.enabled,
              ...(current?.goal
                ? {
                    goal:
                      !input.enabled && current.goal.status === "active"
                        ? {
                            ...current.goal,
                            status: "paused" as const,
                            revision: current.goal.revision + 1,
                            activeMilliseconds: developmentGoalElapsed(current.goal, configuredAt),
                            activatedAt: null,
                            lastSummary:
                              "지속 작업실을 꺼 자동 후속 진행을 일시정지했습니다. 기존 작업과 목표는 보존합니다.",
                          }
                        : current.goal,
                  }
                : {}),
              revision: current?.revision ?? 0,
              policyRevision: (current?.policyRevision ?? 0) + 1,
              mainObservedRevision: current?.mainObservedRevision ?? 0,
              mainActedRevision: current?.mainActedRevision ?? 0,
              pendingMainNotification: current?.pendingMainNotification ?? false,
              ownerModels: input.ownerModels,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode ?? thread.value.interactionMode,
              maxParallelOwners: input.maxParallelOwners,
              verificationCommands: input.verificationCommands,
              workspaces: current?.workspaces ?? [],
              maxDailyTokens:
                input.maxDailyTokens === undefined
                  ? (current?.maxDailyTokens ?? null)
                  : input.maxDailyTokens,
              tasks: current?.tasks ?? [],
              verifications: current?.verifications ?? [],
              integrations: current?.integrations ?? [],
              bindings: [
                {
                  id:
                    current?.bindings.find((binding) => binding.role === "main")?.id ??
                    DevelopmentBindingId.make(NodeCrypto.randomUUID()),
                  workspaceId: null,
                  role: "main" as const,
                  sessionKey: input.conversationId,
                  nativeSessionId: previousMain?.nativeSessionId ?? null,
                  model: input.mainModel,
                  cwd: root,
                  runtimeIdentity: input.enabled
                    ? stringify(mainInfo.continuationIdentity)
                    : (previousMain?.runtimeIdentity ?? stringify(mainInfo.continuationIdentity)),
                  runGeneration: previousMain?.runGeneration ?? 0,
                  profileRevision: (current?.policyRevision ?? 0) + 1,
                  predecessorId: null,
                },
                ...(current?.bindings.filter((binding) => binding.role !== "main") ?? []),
              ],
            });
          },
        );
        if (thread.value.runtimeMode !== input.runtimeMode) {
          yield* engine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`${input.commandId}:runtime-mode`),
            threadId: input.conversationId,
            runtimeMode: input.runtimeMode,
            createdAt: configuredAt,
          });
        }
        if (
          input.interactionMode !== undefined &&
          thread.value.interactionMode !== input.interactionMode
        ) {
          yield* engine.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`${input.commandId}:interaction-mode`),
            threadId: input.conversationId,
            interactionMode: input.interactionMode,
            createdAt: configuredAt,
          });
        }
        const policyDir = path.join(root, ".workspace");
        yield* fs.makeDirectory(path.join(policyDir, "roles"), { recursive: true });
        yield* fs.makeDirectory(path.join(policyDir, "templates"), { recursive: true });
        // JSON is a YAML subset; paths and applied runtime state remain exclusively in SQLite.
        yield* fs.writeFileString(
          path.join(policyDir, "development.json"),
          stringify(
            WorkspaceDevelopmentDefinition.make({
              schemaVersion: 1,
              projectId: input.projectId,
              ownerModels: input.ownerModels,
              policyRevision: configured.policyRevision,
              verificationCommands: input.verificationCommands,
              maxParallelOwners: input.maxParallelOwners,
              maxDailyTokens: configured.maxDailyTokens ?? null,
            }),
          ),
        );
        for (const [name, content] of [
          ["main", MAIN_DEVELOPMENT_INSTRUCTIONS],
          ["architect", ARCHITECT_DEVELOPMENT_INSTRUCTIONS],
        ]) {
          const file = path.join(policyDir, "roles", `${name}.md`);
          if (!(yield* fs.exists(file))) yield* fs.writeFileString(file, content!);
        }
        const ownerTemplate = path.join(policyDir, "templates", "owner.md");
        if (!(yield* fs.exists(ownerTemplate)))
          yield* fs.writeFileString(
            ownerTemplate,
            ownerDevelopmentInstructions("{{name}}", ["{{scope}}"]),
          );
        yield* PubSub.publish(changed, input.projectId);
        yield* announce(
          configured,
          input.commandId,
          input.enabled
            ? "지속 작업실 활성화 · 현재 대화가 Main입니다."
            : "지속 작업실 자동 운영 중지",
        );
        yield* Queue.offer(kicks, undefined);
        return configured;
      },
      lock.withPermits(1),
      Effect.mapError(failure),
    );
    const enqueue = Effect.fn("WorkspaceDevelopment.enqueue")(function* (
      state: WorkspaceDevelopmentState,
      workspace: DevelopmentWorkspace,
      commandId: CommandId,
      objective: string,
      criteria: readonly string[],
      source: DevelopmentTask["source"],
      mode: DevelopmentTask["mode"],
      requirementChange = false,
      recoveryStrategy?: DevelopmentTask["recoveryStrategy"],
    ) {
      const requestedAt = yield* now;
      return yield* store.mutate(
        state.projectId,
        commandId,
        {
          kind: "input.queued",
          source: source === "user-direct" ? "user" : "main",
          payload: { workspaceId: workspace.id, mode },
        },
        (current) => {
          if (!current)
            return Effect.fail(
              new WorkspaceDevelopmentError({ message: "작업실 설정이 없습니다." }),
            );
          const latest = requireWorkspace(current, workspace.id)!;
          if (latest.stateRevision !== workspace.stateRevision)
            return Effect.fail(
              new WorkspaceDevelopmentError({
                message: "작업실 상태가 바뀌었습니다. 최신 상태를 다시 확인하세요.",
              }),
            );
          if (source === "main-dispatch") {
            const barrier = developmentDispatchBarrier(current, latest);
            if (barrier) return Effect.fail(new WorkspaceDevelopmentError({ message: barrier }));
            const recoveryBarrier = developmentRecoveryBarrier(
              current,
              latest,
              objective,
              recoveryStrategy,
            );
            if (recoveryBarrier)
              return Effect.fail(new WorkspaceDevelopmentError({ message: recoveryBarrier }));
          }
          const requirementRevision = latest.requirementRevision + (requirementChange ? 1 : 0);
          const task: DevelopmentTask = {
            id: `T-${NodeCrypto.randomUUID()}`,
            commandId,
            workspaceId: workspace.id,
            bindingId: workspace.bindingId,
            goalId:
              source === "main-dispatch" && current.goal?.status === "active"
                ? current.goal.id
                : null,
            source,
            objective,
            ...(recoveryStrategy ? { recoveryStrategy } : {}),
            acceptanceCriteria: criteria,
            requirementRevision,
            mode,
            status: "queued",
            runId: NodeCrypto.randomUUID(),
            fencingGeneration: 0,
            delivery: "pending",
            nativeTurnId: null,
            nativeMessageIds: [],
            messageId: `development-input:${commandId}`,
            baseSha: latest.baseSha,
            candidateSha: null,
            output: "",
            error: null,
            requestedAt,
            completedAt: null,
          };
          const supersedes =
            source === "user-direct" &&
            (requirementChange || mode === "replace" || mode === "takeover");
          return Effect.succeed({
            ...current,
            pendingMainNotification: source === "user-direct" || current.pendingMainNotification,
            tasks: [
              ...(supersedes
                ? supersedeDevelopmentTasks(current.tasks, workspace.id)
                : current.tasks),
              task,
            ],
            workspaces: current.workspaces.map((entry) =>
              entry.id !== workspace.id
                ? entry
                : {
                    ...entry,
                    requirementRevision,
                    stateRevision: current.revision + 1,
                    ...(source === "user-direct"
                      ? {
                          control: "human" as const,
                          takeover: entry.takeover || mode === "takeover",
                          summaryPending: true,
                        }
                      : {}),
                  },
            ),
          });
        },
      );
    });
    const stopActive = Effect.fn("WorkspaceDevelopment.stopActive")(function* (
      state: WorkspaceDevelopmentState,
      workspaceId: string,
    ) {
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      const binding = state.bindings.find((entry) => entry.id === workspace?.bindingId);
      const fiber = active.get(workspaceId);
      if (!binding || !fiber) return;
      yield* provider
        .interruptTurn({ threadId: binding.sessionKey })
        .pipe(Effect.mapError(failure));
      // Fiber interruption waits for executor cleanup; a lease is not replaced on a timer.
      yield* Fiber.interrupt(fiber);
    });
    const directInput = Effect.fn("WorkspaceDevelopment.directInput")(function* (
      input: WorkspaceDevelopmentDirectInput,
    ) {
      const existing = yield* syncExecutionPolicy(yield* read(input.projectId));
      if (existing.tasks.some((task) => task.commandId === input.commandId)) return existing;
      const next = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* read(input.projectId);
          const workspace = requireWorkspace(state, input.workspaceId);
          if (
            !state.enabled ||
            state.conversationId !== input.conversationId ||
            !workspace ||
            workspace.status !== "ready"
          )
            return yield* new WorkspaceDevelopmentError({
              message: "현재 대화에 연결된 실행 가능한 작업실을 선택하세요.",
            });
          if (
            workspace.stateRevision !== input.expectedRevision &&
            !state.tasks.some((task) => task.commandId === input.commandId)
          )
            return yield* new WorkspaceDevelopmentError({
              message: "작업실 상태가 바뀌었습니다. 최신 상태에서 다시 보내세요.",
            });
          return yield* enqueue(
            state,
            workspace,
            input.commandId,
            input.text,
            [],
            "user-direct",
            input.mode,
            input.requirementChange,
          );
        }),
      );
      if (input.mode === "replace" || input.mode === "takeover" || input.requirementChange)
        yield* stopActive(next, input.workspaceId);
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(`${input.commandId}:display`),
        threadId: input.conversationId,
        messageId: MessageId.make(`development-input:${input.commandId}`),
        text: `@${requireWorkspace(next, input.workspaceId)!.name} [${input.mode}${input.requirementChange ? ", 요구 변경" : ""}]\n${input.text}`,
        createdAt: yield* now,
      });
      yield* PubSub.publish(changed, input.projectId);
      yield* Queue.offer(kicks, undefined);
      return next;
    }, Effect.mapError(failure));
    const returnControl = Effect.fn("WorkspaceDevelopment.returnControl")(function* (
      input: WorkspaceDevelopmentReturnControl,
    ) {
      const state = yield* read(input.projectId);
      if (yield* store.hasCommand(input.projectId, input.commandId)) return state;
      const workspace = requireWorkspace(state, input.workspaceId);
      if (!workspace || workspace.stateRevision !== input.expectedRevision)
        return yield* new WorkspaceDevelopmentError({
          message: "제어권을 반환할 최신 작업실 상태가 필요합니다.",
        });
      const next = yield* save(
        input.projectId,
        input.commandId,
        "control.returned",
        "user",
        (current) => ({
          ...current,
          pendingMainNotification: true,
          workspaces: current.workspaces.map((entry) =>
            entry.id === input.workspaceId
              ? {
                  ...entry,
                  takeover: false,
                  control: "reconciling",
                  summaryPending: true,
                  stateRevision: current.revision + 1,
                }
              : entry,
          ),
        }),
      );
      yield* Queue.offer(kicks, undefined);
      return next;
    }, lock.withPermits(1));
    const create = Effect.fn("WorkspaceDevelopment.create")(function* (
      state: WorkspaceDevelopmentState,
      input: WorkspaceDevelopmentAction,
    ) {
      if (!input.name || !input.scope?.length || !input.objective)
        return yield* new WorkspaceDevelopmentError({
          message: "신설할 영역 이름, 담당 범위와 분리 근거 objective가 필요합니다.",
        });
      const root = yield* projectRoot(state.projectId);
      const base = yield* git.inspect(root);
      const model = state.ownerModels[input.modelIndex ?? 0];
      if (!model)
        return yield* new WorkspaceDevelopmentError({
          message: "승인된 Owner 모델 인덱스만 선택할 수 있습니다.",
        });
      const info = yield* provider.getInstanceInfo(model.instanceId);
      const previous = state.workspaces.find(
        (workspace) => workspace.name === input.name && workspace.status !== "retired",
      );
      if (
        previous &&
        (previous.scope.join("\n") !== input.scope.join("\n") ||
          !sameDevelopmentModel(
            state.bindings.find((binding) => binding.id === previous.bindingId)!.model,
            model,
          ))
      )
        return yield* new WorkspaceDevelopmentError({
          message: "기존 작업실의 구성 재시도는 같은 담당 범위와 승인된 프로필을 사용해야 합니다.",
        });
      const workspaceId = previous?.id ?? DevelopmentWorkspaceId.make(NodeCrypto.randomUUID());
      const bindingId = previous?.bindingId ?? DevelopmentBindingId.make(NodeCrypto.randomUUID());
      const prepared = yield* store.mutate(
        state.projectId,
        input.commandId,
        {
          kind: "workspace.provision-planned",
          source: "main",
          payload: { reason: input.objective },
        },
        (current) => {
          if (!current)
            return Effect.fail(new WorkspaceDevelopmentError({ message: "설정이 없습니다." }));
          if (
            current.workspaces.some(
              (workspace) => workspace.name === input.name && workspace.status === "ready",
            )
          )
            return Effect.fail(
              new WorkspaceDevelopmentError({ message: "같은 이름의 기존 작업실을 재사용하세요." }),
            );
          if (previous)
            return Effect.succeed({
              ...current,
              workspaces: current.workspaces.map((workspace) =>
                workspace.id === previous.id
                  ? { ...workspace, status: "provisioning" as const, error: null }
                  : workspace,
              ),
            });
          return Effect.succeed({
            ...current,
            workspaces: [
              ...current.workspaces,
              {
                id: workspaceId,
                name: input.name!,
                scope: input.scope!,
                bindingId,
                worktreePath: null,
                branch: `t3code/workspace-${workspaceId}`,
                baseSha: base.sha,
                observedFingerprint: "",
                generation: 1,
                definitionRevision: 1,
                stateRevision: current.revision + 1,
                requirementRevision: 1,
                control: "managed",
                takeover: false,
                externalUnmanaged: false,
                summaryPending: false,
                status: "provisioning",
                error: null,
                lastSummary: input.objective!,
              },
            ],
            bindings: [
              ...current.bindings,
              {
                id: bindingId,
                workspaceId,
                role: "owner",
                sessionKey: ThreadId.make(`development:${bindingId}`),
                nativeSessionId: null,
                model,
                cwd: "",
                runtimeIdentity: stringify(info.continuationIdentity),
                runGeneration: 0,
                profileRevision: current.policyRevision,
                predecessorId: null,
              },
            ],
          });
        },
      );
      const existing =
        prepared.workspaces.find((workspace) => workspace.id === workspaceId) ??
        prepared.workspaces.find((workspace) => workspace.name === input.name);
      if (!existing)
        return yield* new WorkspaceDevelopmentError({
          message: "작업실 구성 계획을 찾지 못했습니다.",
        });
      if (existing.status === "ready") return prepared;
      const setup = Effect.gen(function* () {
        const result = yield* provision.provision({
          projectCwd: root,
          baseBranch: existing.baseSha,
          branch: existing.branch,
          existingWorktreePath: existing.worktreePath,
          reattachExisting: true,
          startFromOrigin: false,
        });
        const attached = yield* save(
          state.projectId,
          id(),
          "workspace.worktree-attached",
          "runtime",
          (current) => ({
            ...current,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === existing.id
                ? { ...workspace, worktreePath: result.worktreePath }
                : workspace,
            ),
            bindings: current.bindings.map((binding) =>
              binding.id === existing.bindingId
                ? { ...binding, cwd: result.worktreePath }
                : binding,
            ),
          }),
        );
        const binding = attached.bindings.find((binding) => binding.id === existing.bindingId)!;
        yield* bindingIdentity(binding);
        const generation = binding.runGeneration + 1;
        yield* save(state.projectId, id(), "binding.bootstrap-started", "runtime", (current) => ({
          ...current,
          bindings: current.bindings.map((entry) =>
            entry.id === binding.id ? { ...entry, runGeneration: generation } : entry,
          ),
        }));
        const hookError = (error: WorkspaceDevelopmentError) =>
          new WorkspaceAgentExecutionError({ message: error.message });
        // Installed Codex and Claude persist a resumable native conversation only after its first input.
        // This input belongs to the actual Owner, and is visible in the owning conversation.
        yield* executor.execute({
          persistentSessionKey: binding.sessionKey,
          execution: {
            executionId: ProviderExecutionId.make(binding.sessionKey),
            ownerThreadId: attached.conversationId,
            runId: WorkspaceCollaborationRunId.make(NodeCrypto.randomUUID()),
            nodeId: WorkspaceTaskNodeId.make(`bootstrap-${existing.id}`),
            attempt: generation,
          },
          ...(state.goal?.status === "active"
            ? { usageWorkId: developmentGoalWorkId(state.goal) }
            : {}),
          modelSelection: binding.model,
          runtimeMode: attached.runtimeMode,
          interactionMode: attached.interactionMode ?? "default",
          cwd: binding.cwd,
          prompt: `${yield* ownerRoleText(state.projectId, existing)}\n초기 인수인계입니다. 담당 범위와 현재 cwd 및 Git HEAD를 확인하고 한 문장으로 준비 상태를 보고하세요. 코드/파일/Git 변경, 다른 디렉터리 접근, subagent, 네트워크 호출은 하지 마세요. 이후 Main 배정과 사용자 직접 지시는 이 동일 세션으로 전달됩니다.`,
          title: `${existing.name} · Owner 초기 인수인계`,
          displayName: existing.name,
          role: "implementer",
          kind: "orchestration",
          startedAt: yield* now,
          onSessionStarted: (session) =>
            session.cwd === binding.cwd && session.providerInstanceId === binding.model.instanceId
              ? Effect.void
              : Effect.fail(
                  new WorkspaceAgentExecutionError({
                    message: "Owner 세션의 실제 cwd/provider가 구성과 다릅니다.",
                  }),
                ),
          onInputAccepted: (receipt) =>
            recordNative(state.projectId, binding, receipt.resumeCursor).pipe(
              Effect.mapError(hookError),
            ),
        });
        yield* recordNative(state.projectId, binding);
        const snapshot = yield* git.inspect(binding.cwd);
        const definitionDir = path.join(root, ".workspace", "domains");
        yield* fs.makeDirectory(definitionDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(definitionDir, `${existing.id}.json`),
          stringify({
            workspaceId: existing.id,
            name: existing.name,
            scope: existing.scope,
            model: binding.model,
            definitionRevision: existing.definitionRevision,
          }),
        );
        const ready = yield* save(
          state.projectId,
          id(),
          "workspace.activated",
          "runtime",
          (current) => ({
            ...current,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === existing.id
                ? {
                    ...workspace,
                    status: "ready",
                    error: null,
                    observedFingerprint: snapshot.fingerprint,
                    stateRevision: current.revision + 1,
                  }
                : workspace,
            ),
          }),
        );
        yield* announce(
          ready,
          id(),
          `${existing.name} 작업실 연결 완료 · 기존 대화에서 직접 지시할 수 있습니다.`,
        );
        return ready;
      });
      return yield* setup.pipe(
        Effect.catchCause((cause) =>
          save(state.projectId, id(), "workspace.provision-failed", "runtime", (current) => ({
            ...current,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === existing.id
                ? { ...workspace, status: "failed", error: failure(Cause.squash(cause)).message }
                : workspace,
            ),
          })),
        ),
      );
    }, Effect.mapError(failure));
    const actor = Effect.fn("WorkspaceDevelopment.actor")(function* (scope: McpInvocationScope) {
      const states = yield* store.list;
      const state = states.find(
        (state) => state.enabled && state.conversationId === scope.threadId,
      );
      const binding = state?.bindings.find(
        (binding) =>
          binding.sessionKey === (scope.sessionKey ?? scope.threadId) &&
          binding.model.instanceId === scope.providerInstanceId,
      );
      if (!state || !binding)
        return yield* new WorkspaceDevelopmentError({
          message:
            "이 세션은 별도 지속 작업실 관리에 연결되지 않았습니다. 이 오류는 일반 대화의 파일 접근·수정 권한과 무관하므로, 요청된 일반 작업은 현재 대화에서 직접 계속하세요. 이 도구의 상태를 반복 조회할 필요는 없습니다.",
        });
      yield* bindingIdentity(binding);
      yield* recordNative(state.projectId, binding);
      return { state, binding };
    });
    const invoke = Effect.fn("WorkspaceDevelopment.invoke")(function* (
      scope: McpInvocationScope,
      input: WorkspaceDevelopmentAction,
    ) {
      const authenticated = yield* actor(scope);
      if (authenticated.binding.role !== "main" && input.action !== "status")
        return yield* new WorkspaceDevelopmentError({
          message: "관리 명령은 연결된 Main 세션만 실행할 수 있습니다.",
        });
      let state = yield* freshness(authenticated.state.projectId);
      if (
        input.action !== "status" &&
        input.action !== "create" &&
        (yield* store.hasCommand(state.projectId, input.commandId))
      )
        return summary(state);
      if (
        input.action === "dispatch" &&
        state.tasks.some((task) => task.commandId === input.commandId)
      )
        return summary(state);
      if (input.action === "status") {
        if (authenticated.binding.role === "main") {
          state = yield* save(state.projectId, id(), "main.observed", "main", (current) => ({
            ...current,
            mainObservedRevision: current.revision,
          }));
        }
        return summary(yield* withUsage(state));
      }
      if (input.action === "goal-progress") {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            state = yield* read(state.projectId);
            const goal = state.goal;
            if (
              !goal ||
              goal.id !== input.goalId ||
              goal.revision !== input.expectedGoalRevision ||
              !input.objective ||
              !input.outcome
            )
              return yield* new WorkspaceDevelopmentError({
                message: "현재 goalId와 expectedGoalRevision, 진행 요약과 outcome이 필요합니다.",
              });
            if (goal.status !== "active") return summary(state);
            if (
              input.outcome === "wait" &&
              !state.tasks.some((t) => t.status === "queued" || t.status === "running")
            )
              return yield* new WorkspaceDevelopmentError({
                message:
                  "대기 중인 Owner 작업이 없습니다. 다음 단계를 진행하거나 막힌 이유를 기록하세요.",
              });
            if (input.outcome === "complete") {
              const integration = state.integrations.find((i) => i.id === input.integrationId);
              const target = yield* git.inspect(yield* projectRoot(state.projectId));
              if (
                !integration ||
                goal.initialIntegrationIds.includes(integration.id) ||
                integration.status !== "release-ready" ||
                !integration.resultSha ||
                !integration.logPaths.length ||
                !target.clean ||
                target.sha !== integration.resultSha ||
                state.tasks.some((t) =>
                  ["queued", "running", "delivery_unknown"].includes(t.status),
                ) ||
                state.workspaces.some(
                  (w) => w.control !== "managed" || w.summaryPending || w.externalUnmanaged,
                )
              )
                return yield* new WorkspaceDevelopmentError({
                  message:
                    "현재 목표의 정확한 로컬 통합과 실제 검증 로그, 최신 요구·제어 상태가 필요합니다.",
                });
              if (
                state.tasks.some(
                  (t) =>
                    t.goalId === goal.id &&
                    t.status !== "superseded" &&
                    (t.status !== "completed" ||
                      !t.candidateSha ||
                      !integration.candidates.includes(t.candidateSha)),
                )
              )
                return yield* new WorkspaceDevelopmentError({
                  message: "현재 목표에 배정한 작업의 완료 후보가 통합에 포함되어야 합니다.",
                });
              for (const verificationId of integration.verificationIds) {
                const verification = state.verifications.find((v) => v.id === verificationId);
                const workspace = requireWorkspace(state, verification?.workspaceId);
                if (
                  !verification ||
                  !workspace ||
                  developmentVerificationBarrier(
                    workspace,
                    verification,
                    (yield* git.inspect(workspace.worktreePath!)).sha,
                  )
                )
                  return yield* new WorkspaceDevelopmentError({
                    message: "통합한 후보의 검증 이후 변경을 먼저 재확인하세요.",
                  });
              }
            }
            const timestamp = yield* now;
            const fingerprint = developmentGoalFingerprint(state);
            state = yield* save(
              state.projectId,
              input.commandId,
              "goal.progress-recorded",
              "main",
              (s) => ({
                ...s,
                goal: {
                  ...s.goal!,
                  revision: s.goal!.revision + 1,
                  progressReported: true,
                  status:
                    input.outcome === "complete"
                      ? "complete"
                      : input.outcome === "blocked"
                        ? "blocked"
                        : "active",
                  phase: input.outcome === "wait" ? "waiting" : "ready",
                  lastSummary: input.objective!,
                  integrationId:
                    input.outcome === "complete" ? input.integrationId! : s.goal!.integrationId,
                  noProgressSteps:
                    fingerprint === s.goal!.progressFingerprint ? s.goal!.noProgressSteps + 1 : 0,
                  progressFingerprint: fingerprint,
                  activeMilliseconds: developmentGoalElapsed(s.goal!, timestamp),
                  activatedAt:
                    input.outcome === "complete" || input.outcome === "blocked" ? null : timestamp,
                },
              }),
            );
            return summary(state);
          }),
        );
      }
      if (
        state.goal &&
        !["active", "complete", "cancelled"].includes(state.goal.status) &&
        input.action !== "reconcile"
      )
        return yield* new WorkspaceDevelopmentError({
          message: "사용자가 자동 목표 진행을 중단했습니다. 새로운 배정·구성·통합을 보류합니다.",
        });
      const tokenLimit = yield* stopAtBudget(state);
      if (tokenLimit) return yield* new WorkspaceDevelopmentError({ message: tokenLimit });
      if (input.action === "create")
        return yield* topologyLock.withPermits(1)(
          Effect.gen(function* () {
            if (active.size + auxiliaryRuns.size >= 3)
              return yield* new WorkspaceDevelopmentError({
                message: "병렬 실행 상한에 도달했습니다. 실행 완료 후 구성하세요.",
              });
            const reservation = `topology-${state.projectId}`;
            auxiliaryRuns.add(reservation);
            return summary(
              yield* create(yield* read(state.projectId), input).pipe(
                Effect.ensuring(
                  Effect.sync(() => auxiliaryRuns.delete(reservation)).pipe(
                    Effect.andThen(Queue.offer(kicks, undefined)),
                  ),
                ),
              ),
            );
          }),
        );
      if (input.action === "architect") {
        if (!input.objective)
          return yield* new WorkspaceDevelopmentError({
            message: "Architect 검토 목표가 필요합니다.",
          });
        const root = yield* projectRoot(state.projectId);
        let binding = state.bindings.find((binding) => binding.role === "architect");
        if (!binding) {
          const model = state.ownerModels[input.modelIndex ?? 0];
          if (!model)
            return yield* new WorkspaceDevelopmentError({
              message: "승인된 모델 인덱스를 선택하세요.",
            });
          const info = yield* provider.getInstanceInfo(model.instanceId);
          const bindingId = DevelopmentBindingId.make(NodeCrypto.randomUUID());
          const created: DevelopmentSessionBinding = {
            id: bindingId,
            workspaceId: null,
            role: "architect",
            sessionKey: ThreadId.make(`development:${bindingId}`),
            nativeSessionId: null,
            model,
            cwd: root,
            runtimeIdentity: stringify(info.continuationIdentity),
            runGeneration: 0,
            profileRevision: state.policyRevision,
            predecessorId: null,
          };
          state = yield* save(state.projectId, id(), "architect.bound", "main", (current) => ({
            ...current,
            bindings: [...current.bindings, created],
          }));
          binding = created;
        }
        const architect = binding;
        if (auxiliaryRuns.has(architect.id) || active.size + auxiliaryRuns.size >= 3)
          return yield* new WorkspaceDevelopmentError({
            message: "Architect가 이미 실행 중이거나 병렬 실행 상한에 도달했습니다.",
          });
        yield* bindingIdentity(architect);
        const generation = architect.runGeneration + 1;
        const entered = yield* save(
          state.projectId,
          input.commandId,
          "architect.run-started",
          "main",
          (current) => ({
            ...current,
            bindings: current.bindings.map((binding) =>
              binding.id === architect.id ? { ...binding, runGeneration: generation } : binding,
            ),
          }),
        );
        const executionId = ProviderExecutionId.make(architect.sessionKey);
        auxiliaryRuns.add(architect.id);
        const output = yield* executor
          .execute({
            persistentSessionKey: architect.sessionKey,
            ...(state.goal?.status === "active"
              ? { usageWorkId: developmentGoalWorkId(state.goal) }
              : {}),
            execution: {
              executionId,
              ownerThreadId: state.conversationId,
              runId: WorkspaceCollaborationRunId.make(NodeCrypto.randomUUID()),
              nodeId: WorkspaceTaskNodeId.make(`architect-${generation}`),
              attempt: generation,
            },
            modelSelection: architect.model,
            runtimeMode: state.runtimeMode,
            interactionMode: state.interactionMode ?? "default",
            cwd: root,
            prompt: `${yield* roleText(state.projectId, path.join("roles", "architect.md"), ARCHITECT_DEVELOPMENT_INSTRUCTIONS)}\n이번 검토는 코드와 Git을 변경하지 않는 계획 검토입니다.\n${summary(entered)}\n${input.objective}`,
            title: "Architect · 담당 범위 검토",
            displayName: "Architect",
            role: "coordinator",
            kind: "orchestration",
            startedAt: yield* now,
            onInputAccepted: (receipt) =>
              recordNative(state.projectId, architect, receipt.resumeCursor).pipe(
                Effect.mapError(
                  (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                ),
              ),
          })
          .pipe(
            Effect.ensuring(
              Effect.sync(() => auxiliaryRuns.delete(architect.id)).pipe(
                Effect.andThen(Queue.offer(kicks, undefined)),
              ),
            ),
          );
        yield* recordNative(state.projectId, architect);
        const completedAt = yield* now;
        const completed = yield* save(
          state.projectId,
          id(),
          "architect.run-completed",
          "architect",
          (current) => ({
            ...current,
            architectReview: {
              commandId: input.commandId,
              bindingId: architect.id,
              runGeneration: generation,
              output,
              completedAt,
            },
          }),
        );
        return summary(completed);
      }
      const workspace = requireWorkspace(state, input.workspaceId);
      if (input.action === "dispatch") {
        if (
          !workspace ||
          !input.objective ||
          !input.acceptanceCriteria?.length ||
          input.expectedRevision !== workspace.stateRevision
        )
          return yield* new WorkspaceDevelopmentError({
            message: "최신 workspaceId와 expectedRevision, 목표와 완료조건이 필요합니다.",
          });
        state = yield* enqueue(
          state,
          workspace,
          input.commandId,
          input.objective,
          input.acceptanceCriteria,
          "main-dispatch",
          "queue",
          false,
          input.recoveryStrategy,
        );
        yield* announce(
          state,
          input.commandId,
          `${workspace.name}: Main 배정을 지속 Owner 대기열에 추가했습니다.`,
        );
        yield* PubSub.publish(changed, state.projectId);
        yield* Queue.offer(kicks, undefined);
        return summary(state);
      }
      if (input.action === "reconcile") {
        if (
          !workspace ||
          !input.objective ||
          input.expectedRevision !== workspace.stateRevision ||
          active.has(workspace.id)
        )
          return yield* new WorkspaceDevelopmentError({
            message: "최신 작업실, 후속 영향 처리 결과 objective와 실행 종료가 필요합니다.",
          });
        const sessions = yield* provider.listSessions();
        const binding = state.bindings.find((binding) => binding.id === workspace.bindingId)!;
        if (
          sessions.some(
            (session) => session.threadId === binding.sessionKey && session.activeTurnId,
          )
        )
          return yield* new WorkspaceDevelopmentError({
            message: "실제 Owner가 실행 중이므로 writer 제어권을 바꾸지 않습니다.",
          });
        const snapshot = yield* git.inspect(workspace.worktreePath!);
        state = yield* save(
          state.projectId,
          input.commandId,
          "main.impact-resolved",
          "main",
          (current) => ({
            ...current,
            mainActedRevision: current.revision + 1,
            workspaces: current.workspaces.map((entry) =>
              entry.id === workspace.id
                ? {
                    ...entry,
                    control: entry.takeover ? "human" : "managed",
                    externalUnmanaged: false,
                    summaryPending: false,
                    observedFingerprint: snapshot.fingerprint,
                    stateRevision: current.revision + 1,
                    lastSummary: input.objective!,
                  }
                : entry,
            ),
          }),
        );
        yield* Queue.offer(kicks, undefined);
        return summary(state);
      }
      if (input.action === "verify") {
        if (
          !workspace ||
          active.has(workspace.id) ||
          !input.candidateSha ||
          input.expectedRevision !== workspace.stateRevision
        )
          return yield* new WorkspaceDevelopmentError({
            message: "종료된 작업실의 최신 개정과 정확한 candidateSha가 필요합니다.",
          });
        const barrier = developmentDispatchBarrier(state, workspace);
        if (barrier) return yield* new WorkspaceDevelopmentError({ message: barrier });
        const snapshot = yield* git.inspect(workspace.worktreePath!);
        if (!snapshot.clean || snapshot.sha !== input.candidateSha)
          return yield* new WorkspaceDevelopmentError({
            message: "candidateSha는 깨끗한 Owner HEAD와 같아야 합니다.",
          });
        const root = yield* projectRoot(state.projectId);
        const target = yield* git.inspect(root);
        const checkout = yield* git.fixedCheckout(root, input.candidateSha);
        const verificationId = NodeCrypto.randomUUID();
        const result = yield* git
          .verify(checkout, state.verificationCommands, verificationId, input.evidencePaths)
          .pipe(Effect.ensuring(git.releaseCheckout(root, checkout)));
        const current = yield* freshness(state.projectId);
        const currentWorkspace = requireWorkspace(current, workspace.id)!;
        const stale =
          currentWorkspace.stateRevision !== workspace.stateRevision ||
          (yield* git.inspect(root)).sha !== target.sha;
        const verifiedAt = yield* now;
        state = yield* save(
          state.projectId,
          input.commandId,
          "verification.recorded",
          "verification",
          (current) => ({
            ...current,
            verifications: [
              ...current.verifications,
              {
                id: verificationId,
                workspaceId: workspace.id,
                candidateSha: input.candidateSha!,
                requirementRevision: workspace.requirementRevision,
                generation: workspace.generation,
                targetSha: target.sha,
                commands: result.commands,
                artifacts: result.artifacts,
                status: stale ? "stale" : result.passed ? "passed" : "failed",
                verifiedAt,
              },
            ],
          }),
        );
        return summary(state);
      }
      if (input.action === "integrate")
        return yield* integrationLock.withPermits(1)(
          Effect.gen(function* () {
            if (!input.verificationIds?.length)
              return yield* new WorkspaceDevelopmentError({
                message: "정확한 verificationIds가 필요합니다.",
              });
            const root = yield* projectRoot(state.projectId);
            const target = yield* git.inspect(root);
            if (!target.clean || !target.branch)
              return yield* new WorkspaceDevelopmentError({
                message:
                  "통합 위치는 브랜치가 체크아웃되어 있고 깨끗해야 합니다. 사용자 변경을 먼저 보존하세요.",
              });
            const candidates: string[] = [];
            for (const verificationId of input.verificationIds) {
              const verification = state.verifications.find((entry) => entry.id === verificationId);
              const workspace = state.workspaces.find(
                (entry) => entry.id === verification?.workspaceId,
              );
              if (
                !verification ||
                !workspace ||
                active.has(workspace.id) ||
                verification.targetSha !== target.sha
              )
                return yield* new WorkspaceDevelopmentError({
                  message: "현재 target과 일치하는 고정 후보 검증이 필요합니다.",
                });
              const snapshot = yield* git.inspect(workspace.worktreePath!);
              const barrier =
                developmentVerificationBarrier(workspace, verification, snapshot.sha) ??
                developmentDispatchBarrier(state, workspace);
              if (barrier || !snapshot.clean)
                return yield* new WorkspaceDevelopmentError({
                  message: barrier ?? "Owner에 미커밋 변경이 있습니다.",
                });
              candidates.push(verification.candidateSha);
            }
            const integrationId = NodeCrypto.randomUUID();
            const checkout = yield* git.fixedCheckout(root, target.sha);
            const result = yield* Effect.gen(function* () {
              for (const candidate of candidates)
                yield* git.git(checkout, [
                  "-c",
                  "user.name=T3 Workspace",
                  "-c",
                  "user.email=workspace@localhost",
                  "merge",
                  "--no-edit",
                  "--no-ff",
                  candidate,
                ]);
              const verified = yield* git.verify(
                checkout,
                state.verificationCommands,
                integrationId,
                input.evidencePaths,
              );
              if (!verified.passed)
                return {
                  status: "failed" as const,
                  resultSha: null,
                  error: "통합 검증 실패",
                  logPaths: verified.commands.map((command) => command.logPath),
                  artifacts: verified.artifacts,
                };
              return yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  const latest = yield* git.inspect(root);
                  const fresh = yield* freshness(state.projectId);
                  if (
                    !fresh.enabled ||
                    (fresh.goal?.pendingMessageId && fresh.goal.status !== "active") ||
                    !latest.clean ||
                    latest.sha !== target.sha ||
                    fresh.workspaces.some(
                      (entry) =>
                        input.verificationIds!.some(
                          (vid) =>
                            state.verifications.find((v) => v.id === vid)?.workspaceId === entry.id,
                        ) &&
                        (entry.control !== "managed" ||
                          entry.summaryPending ||
                          entry.stateRevision !==
                            state.workspaces.find((old) => old.id === entry.id)?.stateRevision),
                    )
                  )
                    return {
                      status: "stale" as const,
                      resultSha: null,
                      error: "검증 중 통합 기준 또는 요구/제어 상태가 변경됨",
                      logPaths: verified.commands.map((command) => command.logPath),
                      artifacts: verified.artifacts,
                    };
                  const merged = yield* git.inspect(checkout);
                  // merge updates the checked-out tree and index; never update-ref behind the user's checkout.
                  yield* git.git(root, ["merge", "--ff-only", merged.sha]);
                  return {
                    status: "release-ready" as const,
                    resultSha: merged.sha,
                    error: null,
                    logPaths: verified.commands.map((command) => command.logPath),
                    artifacts: verified.artifacts,
                  };
                }),
              );
            }).pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  status: "failed" as const,
                  resultSha: null,
                  error: error.message,
                  logPaths: [] as string[],
                }),
              ),
              Effect.ensuring(git.releaseCheckout(root, checkout)),
            );
            const integrated = yield* save(
              state.projectId,
              input.commandId,
              "integration.recorded",
              "git",
              (current) => ({
                ...current,
                integrations: [
                  ...current.integrations,
                  {
                    id: integrationId,
                    verificationIds: input.verificationIds!,
                    candidates,
                    expectedTargetSha: target.sha,
                    ...result,
                  },
                ],
              }),
            );
            yield* announce(
              integrated,
              input.commandId,
              `로컬 통합 ${result.status}${result.resultSha ? ` · ${result.resultSha}` : ""}`,
            );
            return summary(integrated);
          }),
        );
      return yield* new WorkspaceDevelopmentError({ message: "지원되지 않는 관리 작업입니다." });
    }, Effect.mapError(failure));
    const workflowContext = Effect.fn("WorkspaceDevelopment.workflowContext")(function* (
      projectId: ProjectId,
      threadId: ThreadId,
    ) {
      const state = yield* store.read(projectId);
      if (!state?.enabled || state.conversationId !== threadId) return "";
      const context = stringify({
        goal: state.goal
          ? {
              objective: state.goal.objective,
              acceptanceCriteria: state.goal.acceptanceCriteria,
              status: state.goal.status,
              lastSummary: state.goal.lastSummary,
            }
          : null,
        workspaces: state.workspaces.map(({ name, scope, status, lastSummary }) => ({
          name,
          scope,
          status,
          lastSummary,
        })),
        tasks: state.tasks.slice(-8).map(({ objective, status, error }) => ({
          objective,
          status,
          error,
        })),
      });
      return context.length <= 12_000
        ? context
        : `${context.slice(0, 12_000)}\n[지속 작업 상태 일부 생략]`;
    }, Effect.mapError(failure));
    const prepareMainInput = Effect.fn("WorkspaceDevelopment.prepareMainInput")(function* (
      threadId: ThreadId,
      text: string,
      messageId?: MessageId,
    ) {
      const state = (yield* store.list).find(
        (state) => state.enabled && state.conversationId === threadId,
      );
      if (!state) return text;
      const fresh = yield* freshness(state.projectId);
      const snapshot = yield* queries
        .getThreadDetailSnapshot(threadId, { turnLimit: 8 })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not read recent AI work summaries", { cause }).pipe(
              Effect.as(Option.none()),
            ),
          ),
        );
      const recentWorkflow =
        Option.isSome(snapshot) && snapshot.value.thread.projectId === state.projectId
          ? snapshot.value.thread.messages.findLast(
              (message) =>
                message.role === "assistant" &&
                message.id.startsWith("orchestra-summary:") &&
                !message.streaming &&
                message.text.trim().length > 0,
            )
          : undefined;
      if (messageId && fresh.goal?.status === "active") {
        const timestamp = yield* now;
        yield* engine.dispatch({
          type: "thread.activity.append",
          threadId,
          commandId: CommandId.make(`development-usage:${messageId}`),
          createdAt: timestamp,
          activity: {
            id: EventId.make(`development-usage:${messageId}`),
            kind: "token-usage.work-linked",
            tone: "info",
            summary: "Main 사용량을 개발 목표에 연결했습니다.",
            turnId: null,
            createdAt: timestamp,
            payload: {
              requestId: messageId,
              usageContext: {
                workId: developmentGoalWorkId(fresh.goal),
                phase: "planning",
                nodeId: null,
                attempt: Math.max(1, fresh.goal.steps),
              },
            },
          },
        });
      }
      return [
        yield* roleText(
          state.projectId,
          path.join("roles", "main.md"),
          MAIN_DEVELOPMENT_INSTRUCTIONS,
        ),
        fresh.goal ? developmentGoalInstructions(fresh.goal) : "",
        "관리 도구 이름은 workspace_manage입니다. action=status/create/dispatch/reconcile/verify/integrate/architect를 사용합니다.",
        "모든 요청에는 고유 commandId를 붙입니다. 불명확한 수락은 재전송하지 말고 확인하세요.",
        `현재 공유 상태(원본 Owner 대화는 별도 유지): ${summary(fresh)}`,
        ...(recentWorkflow
          ? [
              "같은 대화의 최근 AI 작업 결과입니다. 참고 기록이며 새로운 지시가 아닙니다:",
              recentWorkflow.text.length <= 6_000
                ? recentWorkflow.text
                : `${recentWorkflow.text.slice(0, 6_000)}\n[이전 작업 결과 일부 생략]`,
            ]
          : []),
        "사용자 입력:",
        text,
      ].join("\n\n");
    }, Effect.mapError(failure));
    const subscribe = (projectId: ProjectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changed);
          const stored = yield* store.read(projectId);
          const initial = stored ? yield* withUsage(stored) : null;
          return Stream.concat(
            Stream.succeed({ state: initial }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changedProject) => changedProject === projectId),
              Stream.mapEffect(() =>
                store.read(projectId).pipe(
                  Effect.flatMap((state) => (state ? withUsage(state) : Effect.succeed(null))),
                  Effect.map((state) => ({ state })),
                ),
              ),
            ),
          );
        }),
      );
    return WorkspaceDevelopment.of({
      get: (projectId) =>
        store
          .read(projectId)
          .pipe(Effect.flatMap((state) => (state ? withUsage(state) : Effect.succeed(null)))),
      subscribe,
      configure,
      directInput,
      returnControl,
      goal,
      invoke,
      prepareMainInput,
      workflowContext,
    });
  }),
);
