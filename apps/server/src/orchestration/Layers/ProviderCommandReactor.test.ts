// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  WorkspaceMemoryError,
  WorkspaceKnowledgeItemId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { UpgradeRoomMemory } from "../UpgradeRoomMemory.ts";
import type { UpgradeRoomKnowledge } from "../upgradeRoomKnowledge.ts";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const decodeSentText = Schema.decodeUnknownSync(
  Schema.Struct({ input: Schema.optionalKey(Schema.String) }),
);
const decodeQuotedPath = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const decodeAccountSelection = Schema.decodeUnknownSync(
  Schema.Struct({ modelSelection: ModelSelection }),
);

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { upgradeRoomIds } from "../../upgradeRoom.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { account } from "../../provider/testUtils/providerAccountFixture.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import { ANTIGRAVITY_QUESTION_INSTRUCTIONS } from "../textQuestions.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { WorkspaceDevelopment } from "../WorkspaceDevelopment.ts";
import {
  orchestraStopTargets,
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { RECOVERY_BACKGROUND_TEXT, RECOVERY_TURN_TEXT } from "../backgroundWatchRecovery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | SqlClient.SqlClient
    | ServerSettingsService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly providerSnapshots?: ReadonlyArray<ServerProvider>;
    readonly autoSwitch?: ServerSettings["providerAutoSwitch"];
    readonly threadCharacters?: ServerSettings["threadCharacters"];
    readonly globalAssistantProfile?: ServerSettings["globalAssistantProfile"];
    readonly threadAssistantProfiles?: ServerSettings["threadAssistantProfiles"];
    readonly searchModels?: ServerSettings["searchModels"];
    readonly distinctAccountHomes?: boolean;
    readonly baseDir?: string;
    readonly projectWorkspaceRoot?: string;
    readonly upgradeRoom?: NonNullable<ServerConfig["Service"]["upgradeRoom"]>;
    readonly upgradeMemory?: UpgradeRoomKnowledge;
    readonly worktreePath?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly titleRegenerationCompletionDispatchFailures?: number;
    readonly titleRegenerationBeforeStart?: "one" | "two";
    readonly threadRuntimeMode?: "full-access" | "approval-required";
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
    readonly memoryContext?: WorkspaceMemory["Service"]["context"];
    readonly memoryPaths?: WorkspaceMemory["Service"]["contextPaths"];
    readonly memoryHandoff?: WorkspaceMemory["Service"]["handoff"];
    readonly realMemory?: boolean;
    /** When set, a Workspace Development service is provided that reports this
     * project as enabled with a `main` binding on `thread-1` — reproducing the
     * production state that used to cancel every auto-switch. */
    readonly developmentBindingSessionKeys?: ReadonlyArray<string>;
    readonly developmentPrepareMainInput?: WorkspaceDevelopment["Service"]["prepareMainInput"];
    readonly forgottenHandoffIds?: ReadonlyArray<string>;
    readonly forgottenHandoffLookupFailure?: boolean;
    readonly outOfScopeHandoffIds?: ReadonlyArray<string> | null;
    readonly handoffScopeLookupFailure?: boolean;
    readonly hideHandoffMessageId?: string;
    readonly handoffDetailUnavailable?: "error" | "missing";
    readonly workspacePromptFailure?: "settings" | "compose";
    readonly documentSearchFailure?: "search" | "prepare";
    readonly onReactorCommandCommitted?: (command: OrchestrationCommand) => void;
    readonly failRecoveredReceipt?: boolean;
    readonly queuedWatch?: {
      type: "monitor" | "local_bash";
      enabled: boolean;
      revoked?: boolean;
      foreground?: boolean;
    };
    readonly rejectRecoveryStartOnce?: boolean;
    readonly uncertainRecoveryStartOnce?: boolean;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown, _restrictNative?: boolean) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = input?.providerSnapshots ?? [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          nativeSubagentPolicy: (id: ThreadId) => ({
            restricted:
              startSession.mock.calls.findLast(([threadId]) => threadId === id)?.[2] === true,
          }),
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex") &&
              input?.distinctAccountHomes !== true
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const baseProjectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = Layer.effect(
      ProjectionSnapshotQuery,
      Effect.gen(function* () {
        const snapshot = yield* ProjectionSnapshotQuery;
        return {
          ...snapshot,
          ...(input?.handoffDetailUnavailable
            ? {
                getThreadDetailById: () =>
                  input.handoffDetailUnavailable === "error"
                    ? Effect.die("injected handoff detail failure")
                    : Effect.succeed(Option.none()),
              }
            : {}),
          ...(input?.documentSearchFailure
            ? {
                searchWorkspaceRag: () => {
                  if (input.documentSearchFailure === "prepare") {
                    throw new Error("injected document preparation failure");
                  }
                  return Effect.fail(new PersistenceSqlError({ operation: "document search" }));
                },
              }
            : {}),
          ...(input?.workspacePromptFailure === "settings"
            ? { getWorkspaceContextSettings: () => Effect.die("injected settings failure") }
            : {}),
          ...(input?.workspacePromptFailure === "compose"
            ? {
                composeWorkspacePromptForExecution: () => Effect.die("injected compose failure"),
              }
            : {}),
          ...(input?.hideHandoffMessageId
            ? {
                getThreadDetailById: (threadId: ThreadId) =>
                  snapshot.getThreadDetailById(threadId).pipe(
                    Effect.map(
                      Option.map((thread) => ({
                        ...thread,
                        messages: thread.messages.filter(
                          (message) => message.id !== input.hideHandoffMessageId,
                        ),
                      })),
                    ),
                  ),
              }
            : {}),
          ...(input?.forgottenHandoffIds !== undefined || input?.forgottenHandoffLookupFailure
            ? {
                getForgottenThreadMessageIds: () =>
                  input.forgottenHandoffLookupFailure
                    ? Effect.die("injected handoff exclusion lookup failure")
                    : Effect.succeed(input.forgottenHandoffIds ?? []),
              }
            : {}),
          // These provider fixtures do not run WorkspaceMemory's folder classifier.
          getHandoffOutOfScopeMessageIds: () =>
            input?.handoffScopeLookupFailure
              ? Effect.die("injected handoff folder lookup failure")
              : Effect.succeed(
                  input?.outOfScopeHandoffIds === null ? null : (input?.outOfScopeHandoffIds ?? []),
                ),
        } satisfies ProjectionSnapshotQuery["Service"];
      }),
    ).pipe(Layer.provide(baseProjectionSnapshotLayer));
    let titleRegenerationCompletionDispatchAttempts = 0;
    let recoveryStartAttempts = 0;
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents: engine.readEvents,
          dispatch: (command) => {
            if (
              command.type === "thread.turn.start" &&
              command.message.messageId.startsWith("recovered-question-")
            ) {
              recoveryStartAttempts += 1;
              if (recoveryStartAttempts === 1 && input?.rejectRecoveryStartOnce)
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "injected rejected start",
                  }),
                );
              if (recoveryStartAttempts === 1 && input?.uncertainRecoveryStartOnce)
                return Effect.die(new Error("injected uncertain start"));
            }
            if (
              input?.failRecoveredReceipt &&
              command.type === "thread.activity.append" &&
              command.activity.kind === "provider.user-input.delivery.finished" &&
              (command.activity.payload as { outcome?: string }).outcome === "accepted"
            ) {
              return Effect.die(new Error("Injected accepted receipt failure"));
            }
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            return engine
              .dispatch(command)
              .pipe(
                Effect.tap(() => Effect.sync(() => input?.onReactorCommandCommitted?.(command))),
              );
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          latestSequence: engine.latestSequence,
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provide(Layer.succeed(UpgradeRoomMemory, input?.upgradeMemory)),
      Layer.provideMerge(reactorOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          ...(input?.autoSwitch ? { providerAutoSwitch: input.autoSwitch } : {}),
          ...(input?.threadCharacters ? { threadCharacters: input.threadCharacters } : {}),
          ...(input?.searchModels ? { searchModels: input.searchModels } : {}),
          ...(input?.globalAssistantProfile
            ? { globalAssistantProfile: input.globalAssistantProfile }
            : {}),
          ...(input?.threadAssistantProfiles
            ? { threadAssistantProfiles: input.threadAssistantProfiles }
            : {}),
        }),
      ),
      Layer.provideMerge(
        input?.upgradeRoom
          ? Layer.effect(
              ServerConfig,
              Effect.map(ServerConfig, (config) => ({
                ...config,
                upgradeRoom: input.upgradeRoom!,
              })),
            ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)))
          : ServerConfig.layerTest(process.cwd(), baseDir),
      ),
      Layer.provideMerge(
        input?.realMemory
          ? WorkspaceMemory.layer.pipe(
              Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
            )
          : input?.memoryContext || input?.memoryPaths || input?.memoryHandoff
            ? Layer.mock(WorkspaceMemory)({
                context: input.memoryContext ?? (() => Effect.succeed("")),
                contextPaths: input.memoryPaths ?? (() => Effect.succeed([])),
                handoff: input.memoryHandoff ?? (() => Effect.succeed(undefined)),
              })
            : Layer.empty,
      ),
      Layer.provideMerge(
        input?.developmentBindingSessionKeys !== undefined
          ? Layer.succeed(WorkspaceDevelopment, {
              get: () =>
                Effect.succeed({
                  projectId: asProjectId("project-1"),
                  conversationId: ThreadId.make("thread-1"),
                  enabled: true,
                  bindings: input.developmentBindingSessionKeys!.map((sessionKey) => ({
                    id: `binding-${sessionKey}`,
                    workspaceId: null,
                    role: "main",
                    sessionKey: ThreadId.make(sessionKey),
                    nativeSessionId: null,
                    model: modelSelection,
                    cwd: "/tmp/provider-project",
                    profileRevision: 1,
                    runtimeIdentity: null,
                    runGeneration: 0,
                    predecessorId: null,
                  })),
                } as never),
              subscribe: () => Stream.empty,
              configure: () => Effect.die("configure should not be called"),
              directInput: () => Effect.die("directInput should not be called"),
              returnControl: () => Effect.die("returnControl should not be called"),
              goal: () => Effect.die("goal should not be called"),
              invoke: () => Effect.die("invoke should not be called"),
              prepareMainInput:
                input.developmentPrepareMainInput ??
                ((_t: unknown, text: string) => Effect.succeed(text)),
              workflowContext: () => Effect.succeed(""),
            } as never)
          : Layer.empty,
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);

    if (!input?.upgradeRoom)
      await Effect.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId: asProjectId("project-1"),
          title: "Provider Project",
          workspaceRoot: input?.projectWorkspaceRoot ?? "/tmp/provider-project",
          defaultModelSelection: modelSelection,
          createdAt: now,
        }),
      );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: input?.upgradeRoom ? upgradeRoomIds.threadId : ThreadId.make("thread-1"),
        projectId: input?.upgradeRoom ? upgradeRoomIds.projectId : asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: input?.threadRuntimeMode ?? "approval-required",
        branch: null,
        worktreePath: input?.worktreePath ?? null,
        createdAt: now,
      }),
    );
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }

    if (input?.queuedWatch) {
      const threadId = ThreadId.make("thread-1");
      const settings = await runtime.runPromise(Effect.service(ServerSettingsService));
      if (input.queuedWatch.enabled) {
        await runEffect(
          settings.updateSettings({ backgroundWatchThreadUpdate: { threadId, enabled: true } }),
        );
        if (input.queuedWatch.revoked) {
          await runEffect(
            settings.updateSettings({ backgroundWatchThreadUpdate: { threadId, enabled: false } }),
          );
          await runEffect(
            settings.updateSettings({ backgroundWatchThreadUpdate: { threadId, enabled: true } }),
          );
        }
      }
      await runEffect(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("old-task-start"),
          threadId,
          createdAt: now,
          activity: {
            id: EventId.make("old-task"),
            kind: "task.started",
            summary: "historical",
            tone: "info",
            payload: {
              taskId: "actual-task-id",
              agentKind: "background",
              taskType: input.queuedWatch.type,
            },
            createdAt: now,
            turnId: null,
          },
        }),
      );
      await runEffect(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("pre-recovery-session"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      const existing = (await runEffect(snapshotQuery.getSnapshot())).threads.find(
        (item) => item.id === threadId,
      )!;
      const commandId = CommandId.make("pre-recovery-command");
      await runEffect(
        engine.dispatch({
          type: "thread.background-recovery.start",
          commandId,
          threadId,
          expectedThreadUpdatedAt: existing.updatedAt,
          expectedSessionStatus: "ready",
          expectedSessionUpdatedAt: existing.session!.updatedAt,
          activities: [],
          createdAt: now,
          turn: {
            type: "thread.turn.start",
            commandId,
            threadId,
            inputOrigin: "automation",
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            message: {
              messageId: MessageId.make("pre-recovery-message"),
              role: "user",
              text:
                (input.queuedWatch.foreground ? RECOVERY_TURN_TEXT : RECOVERY_BACKGROUND_TEXT) +
                " legacy-watch-details",
              attachments: [],
            },
            createdAt: now,
          },
        }),
      );
    }

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      runEffect,
      sqlClient: () => runtime!.runPromise(Effect.service(SqlClient.SqlClient)),
      journalRows: async () => {
        const sql = await runtime!.runPromise(Effect.service(SqlClient.SqlClient));
        return runEffect(
          sql<{
            state: string;
            updated_at: string;
          }>`SELECT state, updated_at FROM recovery_delivery_journal ORDER BY event_sequence`,
        );
      },
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
    };
  }

  it.each([
    { type: "monitor", enabled: false, sent: false },
    { type: "local_bash", enabled: true, sent: false },
    { type: "monitor", enabled: true, revoked: true, sent: false },
    { type: "monitor", enabled: true, sent: true },
    { type: "monitor", enabled: false, foreground: true, sent: true },
  ] as const)(
    "restores a queued pre-upgrade recovery using current permission and original task evidence %o",
    async (scenario) => {
      const harness = await createHarness({ queuedWatch: scenario });
      await harness.drain();
      expect((await harness.journalRows())[0]?.state).toBe(
        scenario.sent ? "accepted" : "cancelled",
      );
      expect(harness.sendTurn).toHaveBeenCalledTimes(scenario.sent ? 1 : 0);
      const delivered = JSON.stringify(harness.sendTurn.mock.calls);
      expect(delivered).not.toContain("legacy-watch-details");
      if (scenario.sent && scenario.enabled) expect(delivered).toContain("actual-task-id");
      if (scenario.sent && !scenario.enabled) expect(delivered).toContain(RECOVERY_TURN_TEXT);
    },
  );

  it("rechecks watch consent after a queued delivery starts preparing the provider session", async () => {
    const harness = await createHarness({
      queuedWatch: { type: "monitor", enabled: true },
      startSessionEffect: (session) =>
        Effect.promise(async () => {
          const settings = await runtime!.runPromise(Effect.service(ServerSettingsService));
          await runtime!.runPromise(
            settings.updateSettings({
              backgroundWatchThreadUpdate: { threadId: session.threadId, enabled: false },
            }),
          );
          return session;
        }),
    });
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect((await harness.journalRows())[0]?.state).toBe("cancelled");
  });

  it("skips redundant workspace/document RAG on recovery turns that resume native session history", async () => {
    const memoryContext = vi.fn((_projectId: unknown, _query: unknown) =>
      Effect.succeed("<workspace_memory>should-not-run</workspace_memory>"),
    );
    const harness = await createHarness({
      queuedWatch: { type: "monitor", enabled: false, foreground: true },
      startSessionEffect: (session) => Effect.succeed({ ...session, continuity: "resumed" }),
      documentSearchFailure: "search",
      workspacePromptFailure: "compose",
      memoryContext,
    });
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(memoryContext).not.toHaveBeenCalled();
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input ?? "";
    expect(sent).toContain(RECOVERY_TURN_TEXT);
    expect(sent).not.toContain("t3_document_search_unavailable");
    expect(sent).not.toContain("t3_workspace_prompt_unavailable");
    expect((await harness.journalRows())[0]?.state).toBe("accepted");
  });

  it("still loads workspace memory on recovery turns when native session resume falls back", async () => {
    const memoryContext = vi.fn((_projectId: unknown, _query: unknown) =>
      Effect.succeed("<workspace_memory>fallback-context</workspace_memory>"),
    );
    const harness = await createHarness({
      queuedWatch: { type: "monitor", enabled: false, foreground: true },
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: "resume-fallback" }),
      memoryContext,
    });
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(memoryContext).toHaveBeenCalledTimes(1);
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input ?? "";
    expect(sent).toContain("fallback-context");
    expect((await harness.journalRows())[0]?.state).toBe("accepted");
  });

  const finishMockTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    id: string,
    at: string,
  ) => {
    const threadId = ThreadId.make("thread-1");
    const session = (await harness.readModel()).threads.find(
      (thread) => thread.id === threadId,
    )?.session;
    if (!session) throw new Error("Expected a provider session to finish");
    for (const status of ["running", "ready"] as const) {
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`finish-mock-${id}-${status}`),
          threadId,
          session: {
            ...session,
            status,
            activeTurnId: status === "running" ? asTurnId(`finish-mock-${id}`) : null,
            updatedAt: at,
          },
          createdAt: at,
        }),
      );
    }
    await harness.drain();
  };

  const accountSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "selected-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const accountSnapshots = () => [
    account("codex"),
    account("codex_second", {
      usage: { ...account("base").usage!, secondary: { usedPercent: 20 } },
    }),
  ];
  const startAccountTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    suffix: string,
    inputOrigin: "user" | "automation" = "user",
    messageId = `account-message-${suffix}`,
  ) => {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`account-turn-${suffix}`),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId(messageId),
          role: "user",
          text: `Original request ${suffix}`,
          attachments: [],
        },
        inputOrigin,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
      }),
    );
    await harness.drain();
  };

  it("dedicated upgrade room runs an explicit normal turn against the project fixture while primary is offline", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-turn-"));
    createdBaseDirs.add(root);
    const selection = { instanceId: ProviderInstanceId.make("codex_work"), model: "fixture-model" };
    const memory = {
      context: vi.fn(() => "ROOM_MEMORY_FIXTURE"),
      capture: vi.fn(() => 0),
      search: () => [],
    };
    const harness = await createHarness({
      upgradeRoom: { projectRoot: root, primaryHome: NodePath.join(root, "offline") },
      upgradeMemory: memory,
      threadModelSelection: selection,
      autoSwitch: { codex: true, claudeAgent: true },
    });
    const member = {
      role: "advisor" as const,
      model: "fixture-advisor",
      instanceId: selection.instanceId,
    };
    const settings = await runtime!.runPromise(Effect.service(ServerSettingsService));
    await harness.runEffect(settings.updateSettings({ globalSubordinateTeam: [member] }));
    expect(harness.sendTurn).not.toHaveBeenCalled();
    harness.sendTurn.mockImplementation((request) =>
      Effect.sync(() => {
        const cwd = harness.runtimeSessions.find((s) => s.threadId === request.threadId)?.cwd;
        if (cwd !== root) throw new Error("Unexpected fake provider working directory.");
        const file = NodePath.join(cwd, "fixture.txt");
        NodeFS.writeFileSync(file, request.modelSelection!.model);
        expect(NodeFS.readFileSync(file, "utf8")).toBe("fixture-model");
        return { threadId: request.threadId, turnId: asTurnId("fixture-turn") };
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        threadId: upgradeRoomIds.threadId,
        commandId: CommandId.make("fixture-request"),
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        message: {
          messageId: MessageId.make("fixture-message"),
          role: "user",
          text: "Write and read the fixture.",
          attachments: [],
        },
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(memory.context).toHaveBeenCalledExactlyOnceWith("Write and read the fixture.");
    expect(harness.sendTurn.mock.calls[0]?.[1]).toMatchObject({
      source: "global",
      members: [{ ...member, account: selection.instanceId }],
    });
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "ROOM_MEMORY_FIXTURE",
    );
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: selection,
      interactionMode: "plan",
    });
    expect(harness.runtimeSessions[0]?.runtimeMode).toBe("approval-required");
    expect(NodeFS.readFileSync(NodePath.join(root, "fixture.txt"), "utf8")).toBe(selection.model);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("passes selected project skills to Codex in a separate worktree", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-chat-skill-turn-"));
    createdBaseDirs.add(baseDir);
    const project = NodePath.join(baseDir, "project");
    const worktree = NodePath.join(baseDir, "worktree");
    const makeSkill = (root: string, name: string) => {
      const folder = NodePath.join(root, ".agents", "skills", name);
      NodeFS.mkdirSync(folder, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(folder, "SKILL.md"), `---\nname: ${name}\n---\nFixture`);
    };
    makeSkill(project, "resume");
    makeSkill(project, "shared");
    makeSkill(project, "ignored");
    makeSkill(worktree, "shared");
    const harness = await createHarness({
      baseDir,
      projectWorkspaceRoot: project,
      worktreePath: worktree,
    });
    await startAccountTurn(harness, "$resume $shared `$ignored`");
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      workflowSkills: [
        { name: "resume", path: NodePath.join(project, ".agents", "skills", "resume", "SKILL.md") },
        {
          name: "shared",
          path: NodePath.join(worktree, ".agents", "skills", "shared", "SKILL.md"),
        },
      ],
    });
  });

  it("passes the owning project's selected Claude skill to a separate worktree session", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-skill-turn-"));
    createdBaseDirs.add(baseDir);
    const project = NodePath.join(baseDir, "project");
    const worktree = NodePath.join(baseDir, "worktree");
    const folder = NodePath.join(project, ".claude", "skills", "resume");
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.mkdirSync(worktree, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(folder, "SKILL.md"), "---\nname: resume\n---\nFixture");
    const harness = await createHarness({
      baseDir,
      projectWorkspaceRoot: project,
      worktreePath: worktree,
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    });
    await startAccountTurn(harness, "$resume");
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      workflowSkills: [{ name: "resume", path: NodePath.join(folder, "SKILL.md") }],
    });
  });

  it("automatically routes exhausted Codex to an independent account without changing model or effort", async () => {
    const harness = await createHarness({
      threadModelSelection: accountSelection,
      providerSnapshots: accountSnapshots(),
      autoSwitch: { codex: true, claudeAgent: false },
      distinctAccountHomes: true,
    });
    const assignment = Effect.runPromise(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "conversation.turn-assigned",
        ),
        Stream.runHead,
      ),
    );
    await startAccountTurn(harness, "quota");
    await assignment;
    const request = decodeAccountSelection(harness.sendTurn.mock.calls[0]?.[0]);
    expect(request.modelSelection).toEqual({
      ...accountSelection,
      instanceId: ProviderInstanceId.make("codex_second"),
    });
    const snapshot = await harness.readModel();
    expect(snapshot.threads[0]?.modelSelection).toEqual(request.modelSelection);
    expect(snapshot.threads[0]?.activities).toContainEqual(
      expect.objectContaining({
        kind: "conversation.turn-assigned",
        turnId: asTurnId("turn-1"),
        payload: { instanceId: "codex_second", model: accountSelection.model },
      }),
    );
    expect(
      snapshot.threads[0]?.activities.some(
        (activity) => activity.kind === "provider.account.auto-switched",
      ),
    ).toBe(true);
  });

  it("keeps exhausted Codex on its credits and switches immediately on an observed 429 without replay", async () => {
    const snapshots = accountSnapshots();
    snapshots[0] = account("codex", {
      usage: { ...account("base").usage!, credits: { balance: "62500", hasCredits: true } },
    });
    const harness = await createHarness({
      threadModelSelection: accountSelection,
      providerSnapshots: snapshots,
      autoSwitch: { codex: true, claudeAgent: false },
      distinctAccountHomes: true,
    });
    await startAccountTurn(harness, "credits");
    expect(harness.runtimeSessions[0]?.providerInstanceId).toBe("codex");
    const now = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("actual-429"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "HTTP 429 Too Many Requests",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.modelSelection.instanceId).toBe("codex_second");
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    await startAccountTurn(harness, "continue");
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input).toContain(
      "Original request credits",
    );
    // Starting the new session clears the old session error. Its immutable 429
    // fact must still exclude that account for the rest of the cooldown.
    snapshots[0] = account("codex", {
      usage: { ...account("base").usage!, secondary: { usedPercent: 10 } },
    });
    snapshots[1] = account("codex_second");
    snapshots.push(
      account("codex_third", {
        usage: { ...account("base").usage!, secondary: { usedPercent: 60 } },
      }),
    );
    await startAccountTurn(harness, "cooldown");
    expect((await harness.readModel()).threads[0]?.modelSelection.instanceId).toBe("codex_third");
  });

  it("does not switch a duplicate account home", async () => {
    const harness = await createHarness({
      threadModelSelection: accountSelection,
      providerSnapshots: accountSnapshots(),
      autoSwitch: { codex: true, claudeAgent: false },
    });
    await startAccountTurn(harness, "same-home");
    expect(harness.runtimeSessions[0]?.providerInstanceId).toBe("codex");
  });

  it.each([
    ["unknown quota", account("codex", { usage: undefined })],
    [
      "available quota",
      account("codex", { usage: { ...account("codex").usage!, secondary: { usedPercent: 20 } } }),
    ],
    [
      "available credits",
      account("codex", {
        usage: { ...account("codex").usage!, credits: { balance: "20", hasCredits: true } },
      }),
    ],
  ] as const)(
    "does not warn about missing alternatives when the selected account has %s",
    async (_case, provider) => {
      const harness = await createHarness({
        threadModelSelection: accountSelection,
        providerSnapshots: [provider],
        autoSwitch: { codex: true, claudeAgent: false },
      });
      await startAccountTurn(harness, "healthy-no-alternative");
      expect(harness.sendTurn).toHaveBeenCalledOnce();
      expect(
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "provider.account.auto-switch-exhausted",
        ),
      ).toBe(false);
    },
  );

  it("reports no alternative when the selected account is exhausted", async () => {
    const harness = await createHarness({
      threadModelSelection: accountSelection,
      providerSnapshots: [account("codex")],
      autoSwitch: { codex: true, claudeAgent: false },
    });
    await startAccountTurn(harness, "exhausted-no-alternative");
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "provider.account.auto-switch-exhausted",
      ),
    ).toBe(true);
  });

  it("does not warn about missing alternatives for a healthy Claude account", async () => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const harness = await createHarness({
      threadModelSelection: {
        ...accountSelection,
        instanceId: ProviderInstanceId.make("claudeAgent"),
      },
      providerSnapshots: [account("claudeAgent", { driver, usage: undefined })],
      autoSwitch: { codex: false, claudeAgent: true },
    });
    await startAccountTurn(harness, "healthy-claude-no-alternative");
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "provider.account.auto-switch-exhausted",
      ),
    ).toBe(false);
  });

  it("does not automatically reroute an automation profile to an independent account", async () => {
    const harness = await createHarness({
      threadModelSelection: accountSelection,
      providerSnapshots: accountSnapshots(),
      autoSwitch: { codex: true, claudeAgent: false },
      distinctAccountHomes: true,
    });
    await startAccountTurn(harness, "automation", "automation");
    expect((await harness.readModel()).threads[0]?.modelSelection.instanceId).toBe("codex");
    expect(harness.runtimeSessions[0]?.providerInstanceId).toBe("codex");
  });

  it("automatically routes a rate-limited Claude account to its independent second instance", async () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const claudeSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "selected-model",
      options: [],
    };
    const claudeSnapshots = [
      account("claudeAgent", { driver: claude }),
      account("claude_second", { driver: claude, usage: undefined }),
    ];
    const harness = await createHarness({
      threadModelSelection: claudeSelection,
      providerSnapshots: claudeSnapshots,
      autoSwitch: { codex: false, claudeAgent: true },
      distinctAccountHomes: true,
    });
    const now = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("claude-429"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "error",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "You've hit your 5-hour limit · resets 10:30am (Asia/Seoul)",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(
      (await harness.readModel()).threads[0]?.activities.find(
        (activity) => activity.kind === "provider.account.rate-limited",
      )?.summary,
    ).toBe("계정 사용량 또는 요청 제한 확인");
    // The model selection must switch to the independent second Claude instance
    // as soon as the rate-limit error lands — not only on the next turn start.
    expect((await harness.readModel()).threads[0]?.modelSelection).toEqual({
      ...claudeSelection,
      instanceId: ProviderInstanceId.make("claude_second"),
    });
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "provider.account.auto-switched",
      ),
    ).toBe(true);
  });

  it("still auto-switches when the errored session carries a stale activeTurnId", async () => {
    // Reproduces the production defect: a rate-limit error session arrives with
    // its last activeTurnId still attached. Before the fix, the "busy turn"
    // guard treated that stale id as live work and cancelled every switch.
    const claude = ProviderDriverKind.make("claudeAgent");
    const claudeSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "selected-model",
      options: [],
    };
    const claudeSnapshots = [
      account("claudeAgent", { driver: claude }),
      account("claude_second", { driver: claude, usage: undefined }),
    ];
    const harness = await createHarness({
      threadModelSelection: claudeSelection,
      providerSnapshots: claudeSnapshots,
      autoSwitch: { codex: false, claudeAgent: true },
      distinctAccountHomes: true,
    });
    const now = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    // Seed a provider runtime session that is errored but still holds a turn id,
    // matching the shape the adapter emits right after a 429.
    harness.runtimeSessions.push({
      provider: claude,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "error",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      activeTurnId: asTurnId("stale-turn"),
      resumeCursor: { opaque: "resume-stale" },
      createdAt: now,
      updatedAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("claude-429-stale-turn"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "error",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("stale-turn"),
          lastError: "You've hit your 5-hour limit · resets 10:30am (Asia/Seoul)",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.modelSelection).toEqual({
      ...claudeSelection,
      instanceId: ProviderInstanceId.make("claude_second"),
    });
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "provider.account.auto-switched",
      ),
    ).toBe(true);
  });

  it("moves a bound thread off a rate-limited account on the next turn instead of re-entering it", async () => {
    // Reproduces the production ping-pong: the thread is a Workspace Development
    // main binding whose pinned account just returned 429. The rate-limit event
    // already switched the thread to claude_second, but the UI still sends the
    // old claudeAgent selection on the next turn (quota-recheck). Before the
    // fix the binding guard honored that stale selection and the thread dove
    // straight back into the exhausted account.
    const claude = ProviderDriverKind.make("claudeAgent");
    const claudeSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "selected-model",
      options: [],
    };
    const harness = await createHarness({
      threadModelSelection: claudeSelection,
      providerSnapshots: [
        account("claudeAgent", { driver: claude }),
        account("claude_second", { driver: claude, usage: undefined }),
      ],
      autoSwitch: { codex: false, claudeAgent: true },
      distinctAccountHomes: true,
      developmentBindingSessionKeys: ["thread-1"],
    });
    // The thread's session is sitting on a fresh 429, so the selected account is
    // in the blocklist. The next ordinary turn must move, not honor the binding.
    const now = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("claude-429-bind"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "error",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "You've hit your 5-hour limit · resets 10:30am (Asia/Seoul)",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    // A follow-up turn still addressed to the exhausted account must be rerouted
    // to the surviving second instance — the binding no longer pins it.
    await startAccountTurn(harness, "followup");
    const request = decodeAccountSelection(harness.sendTurn.mock.calls[0]?.[0]);
    expect(request.modelSelection.instanceId).toBe(ProviderInstanceId.make("claude_second"));
    expect((await harness.readModel()).threads[0]?.modelSelection.instanceId).toBe(
      ProviderInstanceId.make("claude_second"),
    );
  });

  it("keeps a bound thread on its pinned account when the account is healthy", async () => {
    // Control case: a healthy bound account must NOT be reshuffled by a routine
    // quota probe. The binding guard still applies when the selection is not
    // rate-limited, so the turn stays on claudeAgent.
    const claude = ProviderDriverKind.make("claudeAgent");
    const claudeSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "selected-model",
      options: [],
    };
    const harness = await createHarness({
      threadModelSelection: claudeSelection,
      providerSnapshots: [
        account("claudeAgent", { driver: claude }),
        account("claude_second", { driver: claude, usage: undefined }),
      ],
      autoSwitch: { codex: false, claudeAgent: true },
      distinctAccountHomes: true,
      developmentBindingSessionKeys: ["thread-1"],
    });
    await startAccountTurn(harness, "healthy");
    const request = decodeAccountSelection(harness.sendTurn.mock.calls[0]?.[0]);
    expect(request.modelSelection.instanceId).toBe(ProviderInstanceId.make("claudeAgent"));
  });

  it("keeps an active writer on its original account when receiving a follow-up", async () => {
    const snapshots = accountSnapshots();
    snapshots[0] = account("codex", { usage: undefined });
    const harness = await createHarness({
      threadModelSelection: accountSelection,
      providerSnapshots: snapshots,
      autoSwitch: { codex: true, claudeAgent: false },
      distinctAccountHomes: true,
    });
    await startAccountTurn(harness, "active");
    snapshots[0] = account("codex");
    harness.runtimeSessions[0] = {
      ...harness.runtimeSessions[0]!,
      status: "running",
      activeTurnId: asTurnId("native-active"),
    };
    await startAccountTurn(harness, "followup");
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect((await harness.readModel()).threads[0]?.modelSelection.instanceId).toBe("codex");
  });

  it("applies the global answer style until a conversation has its own, and the conversation's team over the global team", async () => {
    const harness = await createHarness({ threadModelSelection: accountSelection });
    const settings = await runtime!.runPromise(Effect.service(ServerSettingsService));
    const threadId = ThreadId.make("thread-1");
    const blank = {
      preset: "default" as const,
      tone: "",
      length: "",
      explanation: "",
      instructions: "",
    };
    const global = {
      ...blank,
      preset: "professional" as const,
      instructions: "GLOBAL_STYLE_FIXTURE",
    };
    const own = {
      ...blank,
      preset: "detailed" as const,
      tone: "차분하게",
      instructions: "ROOM_STYLE_FIXTURE",
    };
    const worker = {
      instanceId: accountSelection.instanceId,
      model: "global-worker",
      role: "worker" as const,
    };
    const tester = {
      instanceId: accountSelection.instanceId,
      model: "room-tester",
      role: "tester" as const,
      instructions: "수치와 단위를 확인하세요.",
    };
    const sent = async (suffix: string) => {
      await startAccountTurn(harness, suffix);
      const [request, team] = harness.sendTurn.mock.calls.at(-1)!;
      await finishMockTurn(
        harness,
        suffix,
        await harness.runEffect(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
      );
      return { input: decodeSentText(request).input ?? "", team };
    };
    await harness.runEffect(
      settings.updateSettings({ globalResponseStyle: global, globalSubordinateTeam: [worker] }),
    );
    const inherited = await sent("global");
    expect(inherited.input).toContain(global.instructions);
    expect(inherited.team).toMatchObject({
      source: "global",
      members: [{ ...worker, account: accountSelection.instanceId }],
    });

    await harness.runEffect(
      settings.updateSettings({
        threadResponseStyles: {
          [threadId]: own,
          [ThreadId.make("another-room")]: { ...own, instructions: "OTHER_ROOM_FIXTURE" },
        },
        threadSubordinateTeamUpdate: { threadId, members: [tester] },
      }),
    );
    const custom = await sent("room");
    expect(custom.input).toContain(own.instructions);
    expect(custom.input).not.toContain(global.instructions);
    expect(custom.input).not.toContain("OTHER_ROOM_FIXTURE");
    expect(custom.team).toMatchObject({
      source: "room",
      members: [{ ...tester, account: accountSelection.instanceId }],
    });

    // Clearing the conversation's style and team follows the global settings again.
    await harness.runEffect(
      settings.updateSettings({
        threadResponseStyles: { [threadId]: blank },
        threadSubordinateTeamUpdate: { threadId, members: null },
      }),
    );
    const restored = await sent("restored");
    expect(restored.input).toContain(global.instructions);
    expect(restored.team).toMatchObject({
      source: "global",
      members: [{ ...worker, account: accountSelection.instanceId }],
    });

    await harness.runEffect(settings.updateSettings({ globalResponseStyle: null }));
    expect((await sent("cleared")).input).not.toContain("<t3_response_style>");
  });

  it("uses a first-request custom team on the first provider turn unless the saved conversation was edited meanwhile", async () => {
    const harness = await createHarness({ threadModelSelection: accountSelection });
    const settings = await runtime!.runPromise(Effect.service(ServerSettingsService));
    const scope = {
      threadId: ThreadId.make("thread-1"),
      answeringInstanceId: accountSelection.instanceId,
      forModel: accountSelection.model,
    };
    const member = {
      instanceId: scope.answeringInstanceId,
      model: "draft-worker",
      role: "scout" as const,
      instructions: "check the supplied sources",
    };
    const initialModelTeams = [
      { ...scope, members: [member] },
      { ...scope, forModel: "other-model", members: [] },
    ];
    // Simulate a second device editing the saved room before the reactor delivers this turn.
    await harness.runEffect(
      settings.updateSettings({
        threadSubordinateTeamUpdate: { threadId: scope.threadId, members: [] },
      }),
    );
    await harness.runEffect(
      settings.updateSettings({ threadModelTeamUpdate: { ...scope, members: [] } }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("seeded-first"),
        threadId: scope.threadId,
        bootstrapCreateClaim: CommandId.make("cmd-thread-create"),
        initialModelTeams,
        customSubordinateTeam: [member],
        message: {
          messageId: asMessageId("seeded"),
          role: "user",
          text: "review",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: await harness.runEffect(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: "room",
        members: [],
      }),
    );
    const saved = await harness.runEffect(settings.getSettings);
    expect(saved.threadSubordinateTeams[scope.threadId]).toEqual([]);
    expect(saved.threadModelTeams).toEqual(
      expect.arrayContaining([{ ...scope, members: [] }, initialModelTeams[1]]),
    );
  });

  it("resumes with the new native agent policy only between turns", async () => {
    const harness = await createHarness({ threadModelSelection: accountSelection });
    const settings = await runtime!.runPromise(Effect.service(ServerSettingsService));
    const scope = {
      threadId: ThreadId.make("thread-1"),
      answeringInstanceId: accountSelection.instanceId,
      forModel: accountSelection.model,
    };
    await harness.runEffect(
      settings.updateSettings({
        globalSubordinateTeam: [
          { instanceId: scope.answeringInstanceId, model: "native-policy-worker", role: "worker" },
        ],
      }),
    );
    await startAccountTurn(harness, "scoped");
    expect(harness.startSession.mock.calls.map((call) => call[2])).toEqual([true]);
    const first = harness.runtimeSessions[0]!;
    harness.runtimeSessions[0] = { ...first, status: "running", activeTurnId: asTurnId("live") };
    await harness.runEffect(settings.updateSettings({ globalSubordinateTeam: [] }));
    await startAccountTurn(harness, "steer");
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    harness.runtimeSessions[0] = first;
    await finishMockTurn(
      harness,
      "scoped",
      await harness.runEffect(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
    );
    await startAccountTurn(harness, "inherited");
    expect(harness.startSession.mock.calls.map((call) => call[2])).toEqual([true, false]);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: first.resumeCursor,
      runtimeMode: "approval-required",
      providerInstanceId: scope.answeringInstanceId,
    });
  });

  it("restores an offline first-turn team seed once without replaying its provider turn", async () => {
    const harness = await createHarness({ threadModelSelection: accountSelection });
    // Stop the reactor's subscription, leaving the real engine and its SQLite store online.
    await Effect.runPromise(Scope.close(scope!, Exit.void));
    scope = null;
    const reactor = await runtime!.runPromise(Effect.service(ProviderCommandReactor));
    const settings = await runtime!.runPromise(Effect.service(ServerSettingsService));
    const sql = await harness.sqlClient();
    const pending = () =>
      harness.runEffect(
        sql<{ thread_id: string }>`SELECT thread_id FROM pending_thread_model_team_seeds`,
      );
    const restart = () =>
      harness.runEffect(reactor.start().pipe(Effect.andThen(reactor.drain), Effect.scoped));

    const threadId = ThreadId.make("thread-1");
    const team = {
      threadId,
      answeringInstanceId: accountSelection.instanceId,
      forModel: accountSelection.model,
      members: [
        {
          instanceId: ProviderInstanceId.make("codex_second"),
          model: "offline-worker",
          role: "advisor" as const,
          instructions: "Review the sources.",
        },
      ],
    };
    const emptyTeam = { ...team, forModel: "second-model", members: [] };
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("offline-team-first-turn"),
        threadId,
        bootstrapCreateClaim: CommandId.make("cmd-thread-create"),
        initialModelTeams: [team, emptyTeam],
        customSubordinateTeam: team.members,
        message: {
          messageId: asMessageId("offline-team-message"),
          role: "user",
          text: "review",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    expect(await pending()).toEqual([{ thread_id: threadId }]);
    expect((await harness.runEffect(settings.getSettings)).threadModelTeams).toEqual([]);

    await restart();
    expect(
      (await harness.runEffect(settings.getSettings)).threadSubordinateTeams[threadId],
    ).toEqual(team.members);
    expect((await harness.runEffect(settings.getSettings)).threadModelTeams).toEqual([
      team,
      emptyTeam,
    ]);
    expect(await pending()).toEqual([]);
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await harness.runEffect(
      settings.updateSettings({ threadModelTeamUpdate: { ...team, members: null } }),
    );
    expect((await harness.runEffect(settings.getSettings)).threadModelTeams).toEqual([emptyTeam]);
    await restart();
    expect((await harness.runEffect(settings.getSettings)).threadModelTeams).toEqual([emptyTeam]);
    expect(await pending()).toEqual([]);
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("records the current folder for provider handoff even when automatic chat memory is off", async () => {
    let starts = 0;
    const paths = vi.fn<WorkspaceMemory["Service"]["contextPaths"]>(() => Effect.succeed([]));
    const handoff = vi.fn<WorkspaceMemory["Service"]["handoff"]>(() => {
      expect(paths).toHaveBeenCalledTimes(2);
      return Effect.succeed("FOLDER_SCOPED_HANDOFF");
    });
    const harness = await createHarness({
      memoryPaths: paths,
      memoryHandoff: handoff,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.workspace-control.update",
        commandId: CommandId.make("handoff-memory-disabled-settings"),
        projectId: asProjectId("project-1"),
        longTermMemoryRoot: null,
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: false,
          autoChatMemory: false,
        },
      }),
    );
    await startAccountTurn(harness, "before-scoped-switch");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("scoped-switch-worktree"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "after-scoped-switch");
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(paths.mock.calls[1]?.[0]).toMatchObject({
      messageId: asMessageId("account-message-after-scoped-switch"),
      recordCurrent: true,
    });
    expect(decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input).toContain(
      "FOLDER_SCOPED_HANDOFF",
    );
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "conversation.handoff.unavailable",
      ),
    ).toBe(false);
  });

  it("hands off the current conversation even if folder determination fails with automatic memory off", async () => {
    let starts = 0;
    const handoff = vi.fn<WorkspaceMemory["Service"]["handoff"]>(() =>
      Effect.succeed("UNSCOPED_HISTORY"),
    );
    const harness = await createHarness({
      memoryPaths: () => Effect.fail(new WorkspaceMemoryError({ message: "folder unavailable" })),
      memoryHandoff: handoff,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "before-folder-failure");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("failed-folder-switch-worktree"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "after-folder-failure");
    const sent = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
    expect(handoff).toHaveBeenCalled();
    expect(sent).toContain("UNSCOPED_HISTORY");
    expect(sent).toContain("Original request after-folder-failure");
  });

  const nextHandoffDelivery = (harness: Awaited<ReturnType<typeof createHarness>>) =>
    Effect.runPromise(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "conversation.handoff.delivered",
        ),
        Stream.runHead,
      ),
    );

  it("supersedes a failed WorkspaceMemory handoff only after a model switch is accepted", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-receipt-"));
    const harness = await createHarness({
      baseDir,
      projectWorkspaceRoot: baseDir,
      realMemory: true,
    });
    const threadId = ThreadId.make("thread-1");
    const sql = await harness.sqlClient();
    const receipts = async () =>
      (await harness.readModel()).threads[0]!.activities.filter((row) =>
        row.kind.startsWith("conversation.handoff."),
      );
    const switchModel = async (id: string, provider: "codex" | "claudeAgent") => {
      const at = await harness.runEffect(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      await finishMockTurn(harness, id, at);
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(id),
          threadId,
          message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
          modelSelection: {
            instanceId: ProviderInstanceId.make(provider),
            model: `${provider}-fixture`,
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: at,
        }),
      );
      await harness.drain();
    };
    await startAccountTurn(harness, "handoff-seed");
    // Simulate the request being visible to the reactor before its memory projection is available.
    const startSession = harness.startSession.getMockImplementation()!;
    harness.startSession.mockImplementationOnce((key, request) =>
      startSession(key, request).pipe(
        Effect.tap(() =>
          sql`UPDATE projection_thread_messages SET message_id='delayed-fixture'
          WHERE thread_id=${threadId} AND message_id='handoff-failure'`.pipe(Effect.orDie),
        ),
      ),
    );
    await switchModel("handoff-failure", "claudeAgent");
    expect(decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input).toContain(
      "<t3_memory_unavailable>",
    );
    await harness.runEffect(sql`UPDATE projection_thread_messages SET message_id='handoff-failure'
      WHERE thread_id=${threadId} AND message_id='delayed-fixture'`);
    expect(await receipts()).toEqual([
      expect.objectContaining({
        kind: "conversation.handoff.unavailable",
        payload: { reason: "boundary" },
      }),
    ]);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("compact-memory-receipt"),
        threadId,
        handoffMode: "compact",
      }),
    );
    const turnId = asTurnId("provider-accepted-handoff");
    harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId }));
    const delivery = nextHandoffDelivery(harness);
    await switchModel("handoff-recovered", "codex");
    await delivery;
    const prompt = decodeSentText(harness.sendTurn.mock.calls[2]?.[0]).input ?? "";
    const handoff = prompt.match(
      /<t3_conversation_handoff>[\s\S]*?<\/t3_conversation_handoff>/,
    )?.[0];
    expect(handoff).toContain("Original request handoff-seed");
    expect(handoff).not.toContain("gzip NDJSON");
    const afterSuccess = await receipts();
    expect(afterSuccess).toEqual([
      expect.objectContaining({ kind: "conversation.handoff.unavailable" }),
      expect.objectContaining({
        kind: "conversation.handoff.delivered",
        turnId,
        payload: {
          backend: "workspace-memory",
          requestedMode: "compact",
          archiveAttached: false,
          chars: handoff!.length,
        },
      }),
    ]);

    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "sendTurn",
          detail: "synthetic rejection",
        }),
      ),
    );
    await switchModel("handoff-rejected", "claudeAgent");
    expect(decodeSentText(harness.sendTurn.mock.calls[3]?.[0]).input).toContain(
      "<t3_conversation_handoff>",
    );
    expect(await receipts()).toEqual(afterSuccess);
  });

  it("reports a failed memory-service handoff without claiming its folder lookup failed", async () => {
    let starts = 0;
    const harness = await createHarness({
      memoryPaths: () => Effect.succeed([]),
      memoryHandoff: () => Effect.fail(new WorkspaceMemoryError({ message: "archive failure" })),
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "handoff-before-error");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("handoff-error-workspace"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "handoff-after-error");
    const sent = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
    expect(sent).toContain("<t3_handoff_unavailable>");
    expect(sent).toContain("Original request handoff-after-error");
    expect(sent).not.toContain("이전 대화 인계의 폴더 범위를 확인하지 못했습니다");
    expect((await harness.readModel()).threads[0]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation.handoff.unavailable",
          payload: { reason: "prepare" },
        }),
      ]),
    );
  });

  it.each([
    ["<t3_memory_unavailable>missing boundary</t3_memory_unavailable>", "boundary"],
    ["<t3_folder_memory_unavailable>missing folder</t3_folder_memory_unavailable>", "folder"],
  ] as const)("reports a memory service handoff notice for %s", async (notice, reason) => {
    let starts = 0;
    const harness = await createHarness({
      memoryPaths: () => Effect.succeed([]),
      memoryHandoff: () => Effect.succeed(notice),
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, `before-service-${reason}`);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`service-notice-${reason}`),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, `after-service-${reason}`);
    expect(decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input).toContain(notice);
    expect((await harness.readModel()).threads[0]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "conversation.handoff.unavailable", payload: { reason } }),
      ]),
    );
  });

  it("does not send a new provider turn when handoff preparation is interrupted", async () => {
    let starts = 0;
    const harness = await createHarness({
      memoryPaths: () => Effect.succeed([]),
      memoryHandoff: () => Effect.interrupt,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "before-interrupted-handoff");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("interrupted-handoff-workspace"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "interrupted-handoff");
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "conversation.handoff.unavailable",
      ),
    ).toBe(false);
  });

  it.each(["error", "missing"] as const)(
    "continues the user's turn when fallback handoff details are %s",
    async (handoffDetailUnavailable) => {
      let starts = 0;
      const harness = await createHarness({
        handoffDetailUnavailable,
        startSessionEffect: (session) =>
          Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
      });
      await startAccountTurn(harness, `before-${handoffDetailUnavailable}-detail`);
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`handoff-detail-${handoffDetailUnavailable}`),
          threadId: ThreadId.make("thread-1"),
          handoffMode: "compact",
          worktreePath: "/tmp/provider-project-worktree",
        }),
      );
      await startAccountTurn(harness, `after-${handoffDetailUnavailable}-detail`);
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
      const sent = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
      expect(sent).toContain("<t3_handoff_unavailable>");
      expect(sent).toContain(`Original request after-${handoffDetailUnavailable}-detail`);
      expect(sent).not.toContain(`Original request before-${handoffDetailUnavailable}-detail`);
      expect((await harness.readModel()).threads[0]?.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "conversation.handoff.unavailable",
            payload: { reason: "history" },
          }),
        ]),
      );
    },
  );

  it.each([
    ["type95", "차분하고 배려 깊으며"],
    ["k2", "밝고 친근하며"],
    ["ots14", "침착하고 자신감"],
  ] as const)(
    "delivers the %s character style with the user's request",
    async (character, style) => {
      const harness = await createHarness({ threadCharacters: { "thread-1": character } });
      await startAccountTurn(harness, `character-${character}`);
      const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
      expect(sent).toContain(`Original request character-${character}`);
      expect(sent).toContain(style);
      expect(sent).toContain("사용자의 현재 지시");
    },
  );

  it("does not send a different conversation's character style", async () => {
    const harness = await createHarness({ threadCharacters: { "thread-other": "k2" } });
    await startAccountTurn(harness, "character-other-thread");
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).not.toContain("<t3_character_speaking_style>");
  });

  it.each([
    ["gemini", "user", true],
    ["gemini", "automation", false],
    ["codex", "user", false],
    ["claudeAgent", "user", false],
    ["opencode", "user", false],
  ] as const)(
    "question card instructions for a %s %s turn: %s",
    async (instance, origin, expected) => {
      const harness = await createHarness({
        threadModelSelection: {
          instanceId: ProviderInstanceId.make(instance),
          model: "fixture-model",
        },
      });
      await startAccountTurn(harness, `question-card-${instance}-${origin}`, origin);
      const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
      expect(sent).toContain(`Original request question-card-${instance}-${origin}`);
      expect(sent?.includes(ANTIGRAVITY_QUESTION_INSTRUCTIONS)).toBe(expected);
      expect(sent?.includes("<t3_question_card>")).toBe(expected);
    },
  );

  it("sends the answer to an Antigravity text question as the next turn, not as a provider reply", async () => {
    const resolved = Promise.withResolvers<void>();
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("gemini"),
        model: "fixture-model",
      },
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved"
        )
          resolved.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("text-question:turn-asked");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("text-question-open"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("text-question-open"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Antigravity 질문",
          turnId: asTurnId("turn-asked"),
          createdAt: now,
          payload: {
            requestId,
            questions: [
              {
                id: "question-1",
                header: "선택",
                question: "어떻게 처리할까요?",
                options: [
                  { label: "전면 유지", description: "" },
                  { label: "전면 해제", description: "" },
                ],
              },
            ],
          },
        },
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    for (const suffix of ["first", "repeat"]) {
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(`text-question-answer-${suffix}`),
          threadId,
          requestId,
          answers: { "question-1": "전면 유지" },
          createdAt: now,
        }),
      );
      await harness.drain();
    }
    await resolved.promise;
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain(
      "User answers to the questions you asked:\n어떻게 처리할까요?\n전면 유지",
    );
    expect(sent).toContain(ANTIGRAVITY_QUESTION_INSTRUCTIONS);
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.filter(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          (activity.payload as { requestId?: string }).requestId === requestId,
      ),
    ).toHaveLength(1);
  });

  it("sends no assistant role for a thread that follows the global answer style", async () => {
    const harness = await createHarness({
      globalAssistantProfile: { name: "공용", instructions: "전역 검토 지침" },
      threadAssistantProfiles: {
        "thread-1": { name: "개인", instructions: "보관한 맞춤 지침", mode: "global" },
      },
    });
    await startAccountTurn(harness, "global-assistant");
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).not.toContain("<t3_assistant_profile>");
    expect(sent).not.toContain("전역 검토 지침");
    expect(sent).not.toContain("보관한 맞춤 지침");
  });

  it("delivers only this conversation's saved assistant profile and preserves user priority", async () => {
    const harness = await createHarness({
      threadAssistantProfiles: {
        "thread-1": { name: "하나", instructions: "조사를 상세하게 진행한다" },
        "thread-other": { name: "다른 비서", instructions: "다른 대화의 역할" },
      },
    });
    await startAccountTurn(harness, "assistant-profile");
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain("Original request assistant-profile");
    expect(sent).toContain("조사를 상세하게 진행한다");
    expect(sent).toContain("최신 사용자 지시가 이 설정보다 우선");
    expect(sent).not.toContain("다른 대화의 역할");
  });

  it.each(["user", "automation"] as const)(
    "delivers the configured research route to a %s turn",
    async (origin) => {
      const harness = await createHarness({
        searchModels: [{ provider: "baidu", model: "fixture", apiInstanceId: "testing" }],
      });
      await startAccountTurn(harness, "search-order", origin);
      const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
      expect(sent).toContain("workspace_research(action=search");
      expect(sent).toContain("search-directly");
    },
  );

  it("delivers the selected character's style to its automated worker turn", async () => {
    const harness = await createHarness({ threadCharacters: { "thread-1": "k2" } });
    await startAccountTurn(harness, "character-worker", "automation");
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain("밝고 친근하며");
    expect(sent).toContain("지정된 출력 형식");
  });

  it.each(["settings", "compose"] as const)(
    "keeps the user turn running and reports unavailable project memory when %s fails",
    async (workspacePromptFailure) => {
      const harness = await createHarness({
        workspacePromptFailure,
        memoryPaths: () => Effect.succeed([]),
        memoryContext: () => Effect.succeed("<t3_memory_v2>AVAILABLE_MEMORY</t3_memory_v2>"),
      });
      await harness.runEffect(
        harness.engine.dispatch({
          type: "project.workspace-control.update",
          commandId: CommandId.make(`failed-${workspacePromptFailure}-settings`),
          projectId: asProjectId("project-1"),
          longTermMemoryRoot: null,
          contextOptimization: {
            memoryMode: "relevant",
            compactHandoffs: false,
            autoChatMemory: true,
          },
        }),
      );
      await startAccountTurn(harness, `failed-${workspacePromptFailure}`);
      expect(harness.sendTurn).toHaveBeenCalledOnce();
      const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
      expect(sent).toContain(`Original request failed-${workspacePromptFailure}`);
      expect(sent).toContain("AVAILABLE_MEMORY");
      expect(sent).toContain("<t3_workspace_prompt_unavailable>");
      expect(
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "workspace.memory.unavailable",
        ),
      ).toBe(true);
    },
  );

  it("reports unavailable project memory even when the separate memory service is absent", async () => {
    const harness = await createHarness({ workspacePromptFailure: "settings" });
    await startAccountTurn(harness, "settings-without-memory-service");
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "<t3_workspace_prompt_unavailable>",
    );
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "workspace.memory.unavailable",
      ),
    ).toBe(true);
  });

  it.each(["search", "prepare"] as const)(
    "reports document %s failure while preserving the user's request",
    async (documentSearchFailure) => {
      const harness = await createHarness({ documentSearchFailure });
      await startAccountTurn(harness, `document-${documentSearchFailure}`);
      expect(harness.sendTurn).toHaveBeenCalledOnce();
      const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
      expect(sent).toContain(`Original request document-${documentSearchFailure}`);
      expect(sent).toContain(
        documentSearchFailure === "search"
          ? "<t3_document_search_unavailable>"
          : "<t3_document_preparation_unavailable>",
      );
      expect(
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) =>
            activity.kind ===
            (documentSearchFailure === "search"
              ? "document-rag.search-failed"
              : "document-rag.preparation-failed"),
        ),
      ).toBe(true);
    },
  );

  it("connects opt-in project memory to the exact chat input and reports prepared characters", async () => {
    const harness = await createHarness({ memoryPaths: () => Effect.succeed([]) });
    const now = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.workspace-control.update",
        commandId: CommandId.make("memory-settings"),
        projectId: asProjectId("project-1"),
        longTermMemoryRoot: null,
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: false,
          autoChatMemory: true,
        },
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.knowledge.item.upsert",
        commandId: CommandId.make("memory-rule"),
        projectId: asProjectId("project-1"),
        itemId: WorkspaceKnowledgeItemId.make("rule"),
        kind: "directive",
        title: "Mandatory constraint",
        content: "Keep the selected model and reasoning unchanged.",
        status: "active",
        origin: "user",
        scope: "project",
        appliesToFolder: null,
        relativeFolder: null,
        tags: [],
        createdAt: now,
      }),
    );
    const parserEvidence = "Parser implementation details. ".repeat(350) + "ORIGINAL TAIL EVIDENCE";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.knowledge.item.upsert",
        commandId: CommandId.make("parser-memory"),
        projectId: asProjectId("project-1"),
        itemId: WorkspaceKnowledgeItemId.make("parser-reference"),
        kind: "long-term-memory",
        title: "Parser evidence",
        content: parserEvidence,
        status: "active",
        origin: "agent",
        scope: "project",
        appliesToFolder: null,
        relativeFolder: null,
        tags: ["parser"],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("memory-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("memory-user"),
          role: "user",
          text: "Fix the parser.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain("Keep the selected model and reasoning unchanged.");
    expect(sent?.split("Fix the parser.")).toHaveLength(2);
    const sourcePathLiteral = sent?.match(/원문 파일: ("(?:[^"\\]|\\.)*")/u)?.[1];
    expect(sourcePathLiteral).toBeDefined();
    const sourcePath = decodeQuotedPath(sourcePathLiteral);
    expect(NodePath.relative(harness.stateDir, sourcePath).startsWith("..")).toBe(false);
    expect(NodeFS.readFileSync(sourcePath, "utf8")).toContain(parserEvidence);
    const state = await harness.readModel();
    const report = state.threads
      .find((thread) => thread.id === "thread-1")
      ?.activities.find((activity) => activity.kind === "input.composition.prepared")?.payload;
    expect(report).toMatchObject({
      promptChars: sent?.length,
      nativeContext: "unknown",
      estimatedTokens: null,
      status: "prepared",
    });
  });

  it("passes the current folder to automatic chat memory", async () => {
    const paths = vi.fn<WorkspaceMemory["Service"]["contextPaths"]>(() =>
      Effect.succeed(["apps/web/src"]),
    );
    const harness = await createHarness({ memoryPaths: paths });
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.workspace-control.update",
        commandId: CommandId.make("folder-memory-settings"),
        projectId: asProjectId("project-1"),
        longTermMemoryRoot: null,
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: false,
          autoChatMemory: true,
        },
      }),
    );
    for (const [id, folder, content] of [
      ["web-folder", "apps/web", "parser WEB_FOLDER_ONLY"],
      ["server-folder", "apps/server", "parser SERVER_FOLDER_ONLY"],
    ] as const) {
      await harness.runEffect(
        harness.engine.dispatch({
          type: "project.knowledge.item.upsert",
          commandId: CommandId.make(`cmd-${id}`),
          projectId: asProjectId("project-1"),
          itemId: WorkspaceKnowledgeItemId.make(id),
          kind: "long-term-memory",
          title: id,
          content,
          status: "active",
          origin: "user",
          scope: "folder",
          appliesToFolder: folder,
          relativeFolder: null,
          tags: [],
          createdAt: now,
        }),
      );
    }
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("folder-memory-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("folder-memory-message"),
          role: "user",
          text: "parser",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(paths).toHaveBeenCalledWith({
      projectId: asProjectId("project-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("folder-memory-message"),
      cwd: "/tmp/provider-project",
      recordCurrent: true,
    });
    expect(sent).toContain("WEB_FOLDER_ONLY");
    expect(sent).not.toContain("SERVER_FOLDER_ONLY");
  });

  it("tells the provider when the current folder cannot be resolved", async () => {
    const harness = await createHarness({
      memoryPaths: () => Effect.fail(new WorkspaceMemoryError({ message: "folder unavailable" })),
      memoryContext: (_projectId, _task, directivesOnly) =>
        Effect.succeed(directivesOnly ? "REQUIRED_GLOBAL_DIRECTIVE" : "UNEXPECTED_MEMORY"),
    });
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.workspace-control.update",
        commandId: CommandId.make("folder-memory-unavailable-settings"),
        projectId: asProjectId("project-1"),
        longTermMemoryRoot: null,
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: false,
          autoChatMemory: true,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.knowledge.item.upsert",
        commandId: CommandId.make("folder-unavailable-root-knowledge"),
        projectId: asProjectId("project-1"),
        itemId: WorkspaceKnowledgeItemId.make("folder-unavailable-root-item"),
        kind: "long-term-memory",
        title: "unverified root context",
        content: "ROOT_PRIVATE_CANARY",
        status: "active",
        origin: "user",
        scope: "project",
        relativeFolder: null,
        tags: [],
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("folder-memory-unavailable-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("folder-memory-unavailable-message"),
          role: "user",
          text: "계속해",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain("<t3_folder_memory_unavailable>");
    expect(sent).toContain("REQUIRED_GLOBAL_DIRECTIVE");
    expect(sent).not.toContain("UNEXPECTED_MEMORY");
    expect(sent).not.toContain("ROOT_PRIVATE_CANARY");
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "workspace.memory.unavailable",
      ),
    ).toBe(true);
  });

  it("does not report a current folder failure for unclassified earlier history", async () => {
    const harness = await createHarness({
      memoryPaths: () => Effect.succeed([]),
      memoryContext: () =>
        Effect.succeed(
          "<t3_folder_history_unclassified>Earlier history was excluded.</t3_folder_history_unclassified>",
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.workspace-control.update",
        commandId: CommandId.make("unclassified-history-settings"),
        projectId: asProjectId("project-1"),
        longTermMemoryRoot: null,
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: false,
          autoChatMemory: true,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("unclassified-history-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("unclassified-history-message"),
          role: "user",
          text: "계속해",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain("<t3_folder_history_unclassified>");
    expect(sent).not.toContain("<t3_folder_memory_unavailable>");
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "workspace.memory.unavailable",
      ),
    ).toBe(false);
  });

  it("does not attach persistent workspace instructions to a normal user turn", async () => {
    const prepare = vi.fn<WorkspaceDevelopment["Service"]["prepareMainInput"]>((_thread, text) =>
      Effect.succeed(`${text}\nPERSISTENT_MAIN_INSTRUCTIONS`),
    );
    const normal = await createHarness({
      developmentBindingSessionKeys: ["thread-1"],
      developmentPrepareMainInput: prepare,
    });
    await startAccountTurn(normal, "independent-chat");
    expect(prepare).not.toHaveBeenCalled();
    expect(decodeSentText(normal.sendTurn.mock.calls[0]?.[0]).input).not.toContain(
      "PERSISTENT_MAIN_INSTRUCTIONS",
    );
    expect(decodeSentText(normal.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "현재 대화에서 가능한 나머지 승인된 작업은 계속하세요",
    );
  });

  it("only attaches persistent workspace instructions to that workspace's wake turn", async () => {
    const prepare = vi.fn<WorkspaceDevelopment["Service"]["prepareMainInput"]>((_thread, text) =>
      Effect.succeed(`${text}\nPERSISTENT_MAIN_INSTRUCTIONS`),
    );
    const automatic = await createHarness({
      developmentBindingSessionKeys: ["thread-1"],
      developmentPrepareMainInput: prepare,
    });
    await startAccountTurn(
      automatic,
      "workspace-automation",
      "automation",
      "development-wake:project-1:12",
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(decodeSentText(automatic.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "PERSISTENT_MAIN_INSTRUCTIONS",
    );
  });

  it("does not attach old Main instructions to an independent automation in the same conversation", async () => {
    const prepare = vi.fn<WorkspaceDevelopment["Service"]["prepareMainInput"]>((_thread, text) =>
      Effect.succeed(`${text}\nPERSISTENT_MAIN_INSTRUCTIONS`),
    );
    const automatic = await createHarness({
      developmentBindingSessionKeys: ["thread-1"],
      developmentPrepareMainInput: prepare,
    });
    await startAccountTurn(automatic, "orchestra-seat", "automation");
    expect(prepare).not.toHaveBeenCalled();
    expect(decodeSentText(automatic.sendTurn.mock.calls[0]?.[0]).input).not.toContain(
      "PERSISTENT_MAIN_INSTRUCTIONS",
    );
  });

  it("sends the user request to memory before starting a user turn", async () => {
    const context = vi.fn<WorkspaceMemory["Service"]["context"]>(() =>
      Effect.succeed("<t3_memory_v2>PROJECT_MEMORY</t3_memory_v2>"),
    );
    const harness = await createHarness({ memoryContext: context });
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-recent-memory"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("current-memory-message"),
          role: "user",
          text: "계속해",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(context).toHaveBeenCalledWith(asProjectId("project-1"), "계속해", false, {
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("current-memory-message"),
    });
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain("PROJECT_MEMORY");
  });

  it("gives automation turns the same workspace RAG and avoids repeating directives", async () => {
    const context = vi.fn<WorkspaceMemory["Service"]["context"]>(() =>
      Effect.succeed(
        "<t3_user_directives>SHARED_USER_DIRECTIVE</t3_user_directives><t3_memory_v2>AUTOMATION_MEMORY</t3_memory_v2>",
      ),
    );
    const harness = await createHarness({
      memoryContext: context,
      memoryPaths: () => Effect.succeed([]),
    });
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.workspace-control.update",
        commandId: CommandId.make("automation-rag-settings"),
        projectId: asProjectId("project-1"),
        longTermMemoryRoot: null,
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: false,
          autoChatMemory: true,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.knowledge.item.upsert",
        commandId: CommandId.make("automation-rag-rule"),
        projectId: asProjectId("project-1"),
        itemId: WorkspaceKnowledgeItemId.make("automation-rule"),
        kind: "directive",
        title: "Automation rule",
        content: "AUTOMATION_DIRECTIVE",
        status: "active",
        origin: "user",
        scope: "project",
        relativeFolder: null,
        tags: [],
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "project.knowledge.item.upsert",
        commandId: CommandId.make("automation-rag-note"),
        projectId: asProjectId("project-1"),
        itemId: WorkspaceKnowledgeItemId.make("automation-note"),
        kind: "long-term-memory",
        title: "Automation note",
        content: "AUTOMATION_RAG_NOTE",
        status: "active",
        origin: "agent",
        scope: "project",
        relativeFolder: null,
        tags: ["automation"],
        createdAt: now,
      }),
    );
    await startAccountTurn(harness, "automation-rag", "automation");
    const sent = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
    expect(sent).toContain("AUTOMATION_RAG_NOTE");
    expect(sent).toContain("AUTOMATION_DIRECTIVE");
    expect(sent).toContain("SHARED_USER_DIRECTIVE");
    // Directives arrive once through the composed prompt, not again via memory.
    expect(sent?.split("AUTOMATION_DIRECTIVE")).toHaveLength(2);
    expect(context).toHaveBeenCalledWith(
      asProjectId("project-1"),
      "Original request automation-rag",
      false,
      expect.objectContaining({
        inheritFolder: true,
        excludeDirectiveReferences: expect.arrayContaining([
          expect.objectContaining({ projectId: "project-1", itemId: "automation-rule" }),
        ]),
      }),
    );
  });

  it("requests folder-scoped previous memory for an automation turn", async () => {
    const context = vi.fn<WorkspaceMemory["Service"]["context"]>(() =>
      Effect.succeed("<t3_memory_v2>PREVIOUS_FOLDER_MEMORY</t3_memory_v2>"),
    );
    const harness = await createHarness({ memoryContext: context });
    await startAccountTurn(harness, "scoped-automation", "automation");
    expect(context).toHaveBeenCalledWith(
      asProjectId("project-1"),
      "Original request scoped-automation",
      false,
      {
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("account-message-scoped-automation"),
        inheritFolder: true,
      },
    );
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "PREVIOUS_FOLDER_MEMORY",
    );
  });

  it("reports a memory preparation failure instead of silently pretending memory was supplied", async () => {
    const context: WorkspaceMemory["Service"]["context"] = () =>
      Effect.fail(new WorkspaceMemoryError({ message: "test memory failure" }));
    const harness = await createHarness({ memoryContext: context });
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-memory-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("memory-failure-message"),
          role: "user",
          text: "계속해",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "<t3_memory_unavailable>",
    );
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(thread?.activities).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "workspace.memory.unavailable" })]),
    );
  });

  it("requires conditions before dispatch and restricts only the approved inspection turn", async () => {
    const harness = await createHarness({ threadRuntimeMode: "full-access" });
    const now = "2026-01-01T00:00:00.000Z";
    const conditions = {
      version: 1 as const,
      approvedByUser: true as const,
      sourceText: "세션 재사용 조건 확인",
      goal: "세션 조회",
      scope: "세션만",
      criteria: "6개월 미사용 여부 확인",
      approach: "조회·분석",
      restrictions: "종료·삭제 금지",
      completion: "결과 보고",
      output: "보고서",
      mode: "inspect" as const,
      additionalActions: [],
    };
    const request = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("conditions-missing"),
      threadId: ThreadId.make("thread-1"),
      requireTaskConditions: true,
      message: {
        messageId: asMessageId("conditions-missing-message"),
        role: "user" as const,
        text: conditions.sourceText,
        attachments: [],
      },
      runtimeMode: "full-access" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    };
    await expect(harness.runEffect(harness.engine.dispatch(request))).rejects.toThrow(
      "작업 조건을 작성",
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await harness.runEffect(
      harness.engine.dispatch({
        ...request,
        commandId: CommandId.make("conditions-inspect"),
        taskConditions: conditions,
        message: { ...request.message, messageId: asMessageId("conditions-inspect-message") },
      }),
    );
    await harness.drain();
    expect(harness.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({ interactionMode: "plan" });
    expect(decodeSentText(harness.sendTurn.mock.calls.at(-1)?.[0]).input).toContain(
      "6개월 미사용 여부 확인",
    );
    let thread = (await harness.readModel()).threads.find((entry) => entry.id === request.threadId);
    expect(thread?.runtimeMode).toBe("full-access");
    expect(
      thread?.messages.find((entry) => entry.id === asMessageId("conditions-inspect-message"))
        ?.text,
    ).toContain("## 결과 형식\n보고서");

    await finishMockTurn(harness, "conditions-inspect", now);
    await harness.runEffect(
      harness.engine.dispatch({
        ...request,
        commandId: CommandId.make("conditions-work"),
        taskConditions: { ...conditions, mode: "work" },
        message: { ...request.message, messageId: asMessageId("conditions-work-message") },
      }),
    );
    await harness.drain();
    expect(harness.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
      runtimeMode: "full-access",
    });
    expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
    thread = (await harness.readModel()).threads.find((entry) => entry.id === request.threadId);
    expect(thread?.runtimeMode).toBe("full-access");
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it.each([
    { saved: "full-access", selected: "approval-required", interaction: "plan" },
    { saved: "approval-required", selected: "full-access", interaction: "default" },
  ] as const)(
    "uses the selected turn modes when saved settings differ: $saved → $selected",
    async ({ saved, selected, interaction }) => {
      const harness = await createHarness({ threadRuntimeMode: saved });
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`selected-modes-${saved}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`selected-modes-message-${saved}`),
            role: "user",
            text: "work",
            attachments: [],
          },
          runtimeMode: selected,
          interactionMode: interaction,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await harness.drain();
      expect(harness.startSession.mock.calls.at(-1)?.[1]).toMatchObject({ runtimeMode: selected });
      expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
        interactionMode: interaction,
      });
    },
  );

  it("starts and stops a turn without hydrating the historical tool timeline", async () => {
    const harness = await createHarness();
    const queries = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    const fullRead = vi.spyOn(queries, "getThreadDetailById");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("old-tool-for-runtime-read"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("old-large-tool"),
          tone: "tool",
          kind: "tool.completed",
          summary: "old output",
          payload: { output: "x".repeat(1_000_000) },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("runtime-read-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("runtime-read-message"),
          role: "user",
          text: "continue the work",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("runtime-read-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(fullRead).not.toHaveBeenCalled();
    const state = await harness.readModel();
    expect(
      state.threads
        .find((thread) => thread.id === "thread-1")
        ?.activities.find((activity) => activity.id === "old-large-tool")?.payload,
    ).toEqual({ output: "x".repeat(1_000_000) });
    fullRead.mockRestore();
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("regenerates a thread title from the current conversation", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Resolve stale reconnect state" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing"),
        threadId: ThreadId.make("thread-1"),
        title: "Investigate reconnect regressions",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-title-regeneration"),
          role: "user",
          text: "Please investigate reconnect regressions after restarting the session.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        delta: "The remaining issue is stale reconnect state.",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
      previousTitle: "Investigate reconnect regressions",
      message: [
        "USER:",
        "Please investigate reconnect regressions after restarting the session.",
        "",
        "ASSISTANT:",
        "The remaining issue is stale reconnect state.",
      ].join("\n"),
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Resolve stale reconnect state");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user message when regeneration context is truncated", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserMessage = `Review subagent monitoring risks. ${"Opening context. ".repeat(200)}`;
    const recentUserMessage = `LATEST FINDING: ${"implementation detail ".repeat(320)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Review subagent monitoring risks" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing-long"),
        threadId: ThreadId.make("thread-1"),
        title: "Generic PR review",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-long-title-regeneration"),
          role: "user",
          text: firstUserMessage,
          attachments: [
            {
              type: "image",
              id: "opening-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-middle-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("middle-message-before-long-title-regeneration"),
          role: "user",
          text: "Temporary handoff details.",
          attachments: [
            {
              type: "image",
              id: "middle-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-recent-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("recent-message-before-long-title-regeneration"),
          role: "user",
          text: recentUserMessage,
          attachments: [
            {
              type: "image",
              id: "recent-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-long"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const input = harness.generateThreadTitle.mock.calls[0]?.[0];
    if (!input) {
      throw new Error("Expected a title generation input");
    }
    const message = input.message;
    expect(message.startsWith("USER:\nReview subagent monitoring risks.")).toBe(true);
    expect(message).toContain("[First user message truncated]");
    expect(message).toContain("[Earlier content truncated]");
    expect(message).toContain("image.png");
    expect(message).toHaveLength(8_000);
    expect(input.attachments?.map((attachment) => attachment.id)).toEqual([
      "opening-context-image",
      "recent-context-image",
    ]);
  });

  it("clears title regeneration state left pending across reactor startup", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Thread");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("continues clearing startup title regeneration state after one completion fails", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "two",
      titleRegenerationCompletionDispatchFailures: 1,
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(2);
    const readModel = await harness.readModel();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.titleRegeneration,
    ).not.toBeNull();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.titleRegeneration,
    ).toBeNull();
  });

  it("keeps the current title when regeneration returns the fallback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep meaningful title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-fallback-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep meaningful title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state when generation fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep title after failure",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-failed-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep title after failure");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("retries a failed completion and continues regenerating", async () => {
    const harness = await createHarness({
      titleRegenerationCompletionDispatchFailures: 1,
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle
      .mockReturnValueOnce(Effect.succeed({ title: "Title lost to completion failure" }))
      .mockReturnValueOnce(Effect.succeed({ title: "Recovered regeneration worker" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-completion-failure"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Title lost to completion failure");
    expect(thread?.titleRegeneration).toBeNull();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-after-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(3);
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Recovered regeneration worker");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user context and attachment before the retained tail", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserContext = "USER:\nOld visual issue\n[Attachments: old-issue.png]";
    const truncationMarker = "[Earlier content truncated]\n\n";
    const retainedContext = "x".repeat(
      8_000 - firstUserContext.length - "\n\n".length - truncationMarker.length,
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-truncated-regeneration"),
          role: "user",
          text: "Old visual issue",
          attachments: [
            {
              type: "image",
              id: "old-title-context-image",
              name: "old-issue.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        delta: `content before retained tail${"x".repeat(8_100)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-truncated-context"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `${firstUserContext}\n\n${truncationMarker}${retainedContext}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({
        id: "old-title-context-image",
        name: "old-issue.png",
      }),
    ]);
  });

  it("does not overwrite a manual rename while title regeneration is running", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const generatedTitle = await harness.runEffect(
      Deferred.make<{ readonly title: string }, never>(),
    );
    harness.generateThreadTitle.mockReturnValue(Deferred.await(generatedTitle));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-regeneration-race"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const pendingReadModel = await harness.readModel();
    expect(
      pendingReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.titleRegeneration?.requestId,
    ).toBe(CommandId.make("cmd-thread-title-regeneration-race"));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-during-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep manual rename",
      }),
    );
    await harness.runEffect(
      Deferred.succeed(generatedTitle, { title: "Generated title should not win" }),
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep manual rename");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite a manual rename while title regeneration is queued", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Generated title should not win" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-queued-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-before-regeneration-starts"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep queued manual rename",
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep queued manual rename");
  });

  it("skips superseded title regeneration before generation starts", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Latest regenerated title" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-superseded-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-latest-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Latest regenerated title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "restarts the session with a handoff for a model change when the provider requires a new provider thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* Effect.promise(() => finishMockTurn(harness, "restricted-first", now));
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 2));

        expect(harness.stopSession).toHaveBeenCalledTimes(1);
        expect(harness.startSession).toHaveBeenCalledTimes(2);
        expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
          threadId: ThreadId.make("thread-1"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
        });
        // The fresh provider thread has no history: the switching turn
        // carries the conversation across.
        const secondInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string };
        expect(secondInput.input).toContain("<t3_conversation_handoff>");
        expect(secondInput.input).toContain("second");
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await finishMockTurn(harness, "compatible-codex-first", now);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  effectIt.effect(
    "includes a conversation handoff when native resume falls back to a fresh thread",
    () =>
      Effect.gen(function* () {
        let starts = 0;
        const harness = yield* Effect.promise(() =>
          createHarness({
            startSessionEffect: (session) =>
              Effect.succeed({
                ...session,
                continuity: ++starts === 1 ? "new" : "resume-fallback",
              }),
          }),
        );
        yield* Effect.promise(() => startAccountTurn(harness, "before-native-resume"));
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("native-resume-workspace"),
          threadId: ThreadId.make("thread-1"),
          worktreePath: "/tmp/provider-project-worktree",
        });
        yield* Effect.promise(() => startAccountTurn(harness, "after-native-resume"));
        expect(harness.startSession).toHaveBeenCalledTimes(2);
        const request = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]);
        expect(request.input).toContain("<t3_conversation_handoff>");
        expect(request.input).toContain("Original request before-native-resume");
        expect(request.input).toContain("Original request after-native-resume");
      }),
  );

  it.each([
    ["missing", "new"],
    ["missing", "resumed"],
    ["compatible account", "resumed"],
    ["restarting", "new"],
    ["restarting", "resumed"],
  ] as const)(
    "handles a %s same-provider runtime reporting %s on model switch",
    async (runtime, continuity) => {
      let starts = 0;
      const harness = await createHarness({
        startSessionEffect: (session) =>
          Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : continuity }),
      });
      await startAccountTurn(harness, "continuity-prior");
      const now = await harness.runEffect(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      await finishMockTurn(harness, "continuity-prior", now);
      if (runtime !== "restarting") harness.runtimeSessions.splice(0);
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("continuity-model-switch"),
          threadId: ThreadId.make("thread-1"),
          modelSelection: {
            instanceId: ProviderInstanceId.make(
              runtime === "compatible account" ? "codex_work" : "codex",
            ),
            model: "gpt-5.1-codex",
          },
          ...(runtime === "restarting" ? { worktreePath: "/tmp/continuity-worktree" } : {}),
        }),
      );
      await startAccountTurn(harness, "continuity-current");
      expect(harness.startSession).toHaveBeenCalledTimes(2);
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
      const first = decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input;
      const second = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
      expect(harness.sendTurn.mock.calls[1]?.[0]?.modelSelection?.model).toBe("gpt-5.1-codex");
      expect(first).not.toContain("<t3_conversation_handoff>");
      expect(second?.includes("<t3_conversation_handoff>")).toBe(continuity === "new");
      expect(second?.includes("Original request continuity-prior")).toBe(continuity === "new");
      expect(second).toContain("Original request continuity-current");
    },
  );

  it("keeps a fresh compact handoff text-only when earlier work spans folders", async () => {
    const harness = await createHarness({
      outOfScopeHandoffIds: ["account-message-private-folder"],
      startSessionEffect: (session) => Effect.succeed({ ...session, continuity: "new" }),
    });
    await startAccountTurn(harness, "private-folder");
    const now = await harness.runEffect(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    await finishMockTurn(harness, "private-folder", now);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("compact-cross-folder"),
        threadId: ThreadId.make("thread-1"),
        handoffMode: "compact",
      }),
    );
    harness.runtimeSessions.splice(0);
    const delivery = nextHandoffDelivery(harness);
    await startAccountTurn(harness, "current-folder");
    await delivery;
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    const text = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
    expect(text).toContain("<t3_conversation_handoff>");
    expect(text).toContain("Original request private-folder");
    const activities = (await harness.readModel()).threads[0]?.activities;
    const receipts = activities?.filter((activity) =>
      activity.kind.startsWith("conversation.handoff."),
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        kind: "conversation.handoff.delivered",
        payload: { backend: "projection", requestedMode: "compact", chars: expect.any(Number) },
      }),
    ]);
  });

  it("includes same-conversation history from other or unclassified folders in a fallback handoff", async () => {
    let starts = 0;
    const harness = await createHarness({
      outOfScopeHandoffIds: ["account-message-other-folder", "account-message-unclassified"],
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "same-folder");
    await startAccountTurn(harness, "other-folder");
    await startAccountTurn(harness, "unclassified");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("folder-filter-fallback-worktree"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "folder-current");
    const text = decodeSentText(harness.sendTurn.mock.calls[3]?.[0]).input;
    expect(text).toContain("Original request same-folder");
    expect(text).toContain("Original request other-folder");
    expect(text).toContain("Original request unclassified");
    expect(text).toContain("Original request folder-current");
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "conversation.handoff.unavailable",
      ),
    ).toBe(false);
  });

  it.each(["unrecorded", "lookup failure"] as const)(
    "hands off the conversation even when folder scope is %s",
    async (scenario) => {
      let starts = 0;
      const harness = await createHarness({
        ...(scenario === "unrecorded"
          ? { outOfScopeHandoffIds: null }
          : { handoffScopeLookupFailure: true }),
        startSessionEffect: (session) =>
          Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
      });
      await startAccountTurn(harness, "unverified-prior");
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`folder-unavailable-${scenario}`),
          threadId: ThreadId.make("thread-1"),
          worktreePath: "/tmp/provider-project-worktree",
        }),
      );
      await startAccountTurn(harness, "folder-unavailable-current");
      const text = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
      expect(text).toContain("Original request unverified-prior");
      expect(text).toContain("Original request folder-unavailable-current");
      expect(
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "conversation.handoff.unavailable",
        ),
      ).toBe(false);
    },
  );

  it("excludes forgotten messages from a fallback handoff while retaining other history", async () => {
    let starts = 0;
    const harness = await createHarness({
      forgottenHandoffIds: ["account-message-forgotten-history"],
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "retained-history");
    await startAccountTurn(harness, "forgotten-history");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("filtered-import-activity"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        activity: {
          id: EventId.make("filtered-import-event"),
          kind: "conversation.imported",
          tone: "info",
          summary: "Imported conversation",
          payload: { sourceHash: "a".repeat(64) },
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("filtered-fallback-workspace"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "new-request");
    const text = decodeSentText(harness.sendTurn.mock.calls[2]?.[0]).input;
    expect(text).toContain("Original request retained-history");
    expect(text).not.toContain("Original request forgotten-history");
    expect(text).toContain("Original request new-request");
    expect(text).toContain("기억에서 제외한 발언은 자동 인계에서 생략");
    expect(text).not.toContain("conversation-imports");
  });

  it("reports unavailable handoff history when exclusion lookup fails", async () => {
    let starts = 0;
    const harness = await createHarness({
      forgottenHandoffLookupFailure: true,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "private-prior");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("failed-fallback-workspace"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "current-after-failure");
    const text = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
    expect(text).toContain("기억 제외 상태를 확인하지 못해 자동 인계를 생략했습니다");
    expect(text).not.toContain("Original request private-prior");
    expect(text).toContain("Original request current-after-failure");
    expect((await harness.readModel()).threads[0]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation.handoff.unavailable",
          payload: { reason: "exclusions" },
        }),
      ]),
    );
  });

  it("reports a missing handoff boundary without leaking an unbounded history", async () => {
    let starts = 0;
    const harness = await createHarness({
      hideHandoffMessageId: "account-message-boundary-missing",
      forgottenHandoffIds: [],
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "boundary-prior");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("missing-boundary-mode"),
        threadId: ThreadId.make("thread-1"),
        handoffMode: "compact",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "boundary-missing");
    const text = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
    expect(text).toContain("현재 요청의 대화 위치를 확인하지 못해 이전 대화 인계를 생략했습니다");
    expect(text).not.toContain("Original request boundary-prior");
    expect(text).toContain("Original request boundary-missing");
    expect(text).not.toContain("원문 스냅샷:");
    expect((await harness.readModel()).threads[0]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation.handoff.unavailable",
          payload: { reason: "boundary" },
        }),
      ]),
    );
  });

  it("reports the exclusion even when it removes all prior handoff messages", async () => {
    let starts = 0;
    const harness = await createHarness({
      forgottenHandoffIds: ["account-message-only-prior"],
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, continuity: ++starts === 1 ? "new" : "resume-fallback" }),
    });
    await startAccountTurn(harness, "only-prior");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("empty-fallback-workspace"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await startAccountTurn(harness, "current-only");
    const text = decodeSentText(harness.sendTurn.mock.calls[1]?.[0]).input;
    expect(text).toContain("기억에서 제외한 발언은 자동 인계에서 생략");
    expect(text).not.toContain("Original request only-prior");
    expect(text).toContain("Original request current-only");
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await finishMockTurn(harness, "claude-effort-first", now);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("defers a runtime mode change while a turn is starting and applies it to the next turn", async () => {
    const harness = await createHarness({ threadRuntimeMode: "full-access" });
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("mode-race-first"),
        threadId,
        message: {
          messageId: asMessageId("mode-race-first-message"),
          role: "user",
          text: "first",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(
      (await harness.readModel()).threads.find((thread) => thread.id === threadId)?.session?.status,
    ).toBe("starting");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-race-next-setting"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    const running = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
    expect(running?.runtimeMode).toBe("approval-required");
    expect(running?.session?.runtimeMode).toBe("full-access");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("mode-race-first-finished"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("mode-race-second"),
        threadId,
        message: {
          messageId: asMessageId("mode-race-second-message"),
          role: "user",
          text: "second",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
  });

  it("prevents cross-client model changes from replacing an active turn", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    const start = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("concurrent-first"),
      threadId,
      message: {
        messageId: asMessageId("concurrent-first-message"),
        role: "user" as const,
        text: "first",
        attachments: [],
      },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      createdAt: now,
    };
    await harness.runEffect(harness.engine.dispatch(start));
    await harness.drain();
    const next = {
      ...start,
      commandId: CommandId.make("concurrent-second"),
      message: {
        ...start.message,
        messageId: asMessageId("concurrent-second-message"),
        text: "second",
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    };
    await expect(harness.runEffect(harness.engine.dispatch(next))).rejects.toThrow("현재 작업");
    await harness.drain();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(
      (await harness.readModel()).threads[0]?.messages.some(
        (message) => message.id === next.message.messageId,
      ),
    ).toBe(false);
    await expect(
      harness.runEffect(
        harness.engine.dispatch({ ...next, message: { ...next.message, text: "changed" } }),
      ),
    ).rejects.toThrow();
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("concurrent-first-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("concurrent-first-turn"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("concurrent-first-finished"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(harness.engine.dispatch(next));
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      providerInstanceId: "claudeAgent",
    });
  });

  it("does not restart a provider that is running even when the projected session is ready", async () => {
    const harness = await createHarness({ threadRuntimeMode: "full-access" });
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("provider-running-turn"),
        threadId,
        message: {
          messageId: asMessageId("provider-running-message"),
          role: "user",
          text: "work",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      }),
    );
    await harness.drain();
    harness.runtimeSessions[0] = {
      ...harness.runtimeSessions[0]!,
      status: "running",
      activeTurnId: asTurnId("provider-running"),
    };
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("provider-running-stale-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("provider-running-change-mode"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.runtimeSessions[0]?.status).toBe("running");
    expect(
      (await harness.readModel()).threads.find((thread) => thread.id === threadId)?.runtimeMode,
    ).toBe("approval-required");
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("runtime-mode-first-finished"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("restart-failure-first-finished"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("applies compact handoff only to opted-in human provider switches and reverses to standard", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    let index = 0;
    const now = () => `2026-09-05T03:00:${String(index++).padStart(2, "0")}.000Z`;
    const send = async (id: string, text: string, provider: string, automation = false) => {
      const delivered = await harness.runEffect(Deferred.make<unknown>());
      harness.sendTurn.mockImplementationOnce((value) =>
        Deferred.succeed(delivered, value).pipe(Effect.as({ threadId, turnId: asTurnId(id) })),
      );
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(id),
          threadId,
          message: { messageId: asMessageId(id), role: "user", text, attachments: [] },
          modelSelection: {
            instanceId: ProviderInstanceId.make(provider),
            model: provider === "codex" ? "gpt-5-codex" : "claude-opus-4-6",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: now(),
          ...(automation ? { inputOrigin: "automation" as const } : {}),
        }),
      );
      const request = await harness.runEffect(Deferred.await(delivered));
      await harness.drain();
      await finishMockTurn(harness, `handoff-${id}`, now());
      return typeof request === "object" && request !== null && "input" in request
        ? request.input
        : undefined;
    };
    const initial = await send("initial", "디버 실행은 보류하고 문서 정리를 진행해", "codex");
    expect(initial).toContain("디버 실행은 보류하고 문서 정리를 진행해");
    expect(initial).not.toContain("<t3_conversation_handoff>");
    if (await harness.runEffect(isHostWindows))
      expect(initial).toContain("<t3_windows_shell_policy>");
    for (let n = 0; n < 12; n++) {
      const messageId = asMessageId(`progress-${n}`);
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`delta-${n}`),
          threadId,
          messageId,
          delta:
            n < 10
              ? `과거 조사 ${n}: ${"테스트코드 기록 ".repeat(220)}`
              : "문서 정리를 이어가겠습니다.",
          createdAt: now(),
        }),
      );
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`complete-${n}`),
          threadId,
          messageId,
          createdAt: now(),
        }),
      );
    }
    const setMode = (handoffMode: "standard" | "compact") =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`mode-${index++}`),
          threadId,
          handoffMode,
        }),
      );
    await setMode("compact");
    expect(
      (await harness.readModel()).threads.find((entry) => entry.id === threadId)?.handoffMode,
    ).toBe("compact");
    const compact = await send("switch", "계속 정리해", "claudeAgent");
    expect(
      (await harness.readModel()).threads
        .find((entry) => entry.id === threadId)
        ?.activities.find((entry) => entry.kind === "conversation.handoff.delivered")?.payload,
    ).toMatchObject({
      backend: "projection",
      requestedMode: "compact",
      compactReport: { status: "compact", reason: "reduced" },
    });
    expect(compact).toContain("디버 실행은 보류");
    expect(compact).toContain("SHA-256:");
    expect(compact).not.toContain("과거 조사 0:");
    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId)!;
    expect(thread.handoffMode).toBe("compact");
    expect(thread.messages.find((entry) => entry.id === "switch")?.text).toBe("계속 정리해");
    expect(
      thread.activities.filter((entry) => entry.kind.startsWith("conversation.handoff.")),
    ).toHaveLength(1);
    await setMode("standard");
    const standard = await send("switch-back", "이전 계획을 이어가.", "codex");
    expect(standard).toContain("<t3_conversation_handoff>");
    expect(standard).not.toContain("SHA-256:");
    await setMode("compact");
    const sameProvider = await send("same-provider", "같은 세션이면 계속 이어", "codex");
    expect(sameProvider).toContain("같은 세션이면 계속 이어");
    expect(sameProvider).not.toContain("<t3_conversation_handoff>");
    const automation = await send("automation", "자동화에 불필요한 문맥", "claudeAgent", true);
    expect(automation).toContain("자동화에 불필요한 문맥");
    expect(automation).not.toContain("<t3_conversation_handoff>");
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("hands a live session across drivers with a conversation handoff instead of rejecting", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await finishMockTurn(harness, "provider-switch-first", now);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(1);
    expect(harness.startSession.mock.calls.length).toBe(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    // The incoming driver starts from a blank provider thread: the switching
    // turn carries the conversation across.
    const secondInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string };
    expect(secondInput.input).toContain("<t3_conversation_handoff>");
    expect(secondInput.input).toContain("second");
  });

  it("starts a fresh session for a cross-driver turn once the previous session has stopped", async () => {
    // Only a LIVE session binds a thread to its provider. A stopped one
    // releases the binding ??this is how a meeting thread hands the same
    // conversation from one seat's provider to the next.
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => harness.sendTurn.mock.calls.length > 0);

    expect(harness.startSession.mock.calls.length).toBe(1);
    const startOptions = harness.startSession.mock.calls[0]?.[1] as {
      readonly provider?: string;
      readonly providerInstanceId?: string;
      readonly resumeCursor?: unknown;
    };
    expect(startOptions).toMatchObject({
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
    });
    // The new driver cannot resume the old one's conversation state.
    expect(startOptions.resumeCursor).toBeUndefined();
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("routes an async question stop even when its provider turn is already idle", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const questionRequestId = asApprovalRequestId("async:question-1");

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("async-question-idle-session"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("async-question-stop"),
        threadId: ThreadId.make("thread-1"),
        questionRequestId,
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.interruptTurn).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      questionRequestId,
    });
  });

  it("routes a question stop even when an orchestra run is active", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const questionRequestId = asApprovalRequestId("async:question-with-orchestra");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("orchestra-block-command"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("orchestra-block-event"),
          kind: "orchestra.block",
          tone: "info",
          summary: "Running",
          payload: {
            executionId: "execution-1",
            ownerThreadId: threadId,
            runId: "run-1",
            nodeId: "node-1",
            attempt: 1,
            messageId: "message-1",
            title: "Task",
            displayName: "Agent",
            role: "operator",
            kind: "implementation",
            modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
            status: "running",
          },
          turnId: null,
          createdAt: now,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("orchestra-question-session"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("orchestra-question-stop"),
        threadId,
        questionRequestId,
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.interruptTurn).toHaveBeenCalledWith({ threadId, questionRequestId });
  });

  it("closes a selected orphaned async question when its provider session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const questionRequestId = asApprovalRequestId("async:orphaned-question");
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("orphaned-question-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("orphaned-question-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          payload: { requestId: questionRequestId, questions: [] },
          turnId: null,
          createdAt: now,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("orphaned-question-session-stopped"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("orphaned-question-stop"),
        threadId,
        questionRequestId,
        createdAt: now,
      }),
    );
    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "user-input.resolved",
        payload: expect.objectContaining({ requestId: questionRequestId, answers: {} }),
      }),
    );
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("routes concurrent orchestra approvals and input to their execution sessions without an owner session", async () => {
    const harness = await createHarness();
    const createdAt = "2026-09-11T00:00:00.000Z";
    for (const executionId of ["worker-a", "worker-b"]) {
      for (const kind of ["approval.requested", "user-input.requested"]) {
        const requestId = `${executionId}:${kind}:same-request`;
        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(requestId),
            threadId: ThreadId.make("thread-1"),
            createdAt,
            activity: {
              id: EventId.make(requestId),
              kind,
              tone: "info",
              summary: "Request",
              turnId: null,
              createdAt,
              payload: { requestId, executionId, providerRequestId: "same-request" },
            },
          }),
        );
        await harness.runEffect(
          harness.engine.dispatch(
            kind === "approval.requested"
              ? {
                  type: "thread.approval.respond",
                  commandId: CommandId.make(`respond:${requestId}`),
                  threadId: ThreadId.make("thread-1"),
                  requestId: ApprovalRequestId.make(requestId),
                  decision: "accept",
                  createdAt,
                }
              : {
                  type: "thread.user-input.respond",
                  commandId: CommandId.make(`respond:${requestId}`),
                  threadId: ThreadId.make("thread-1"),
                  requestId: ApprovalRequestId.make(requestId),
                  answers: { choice: executionId },
                  createdAt,
                },
          ),
        );
      }
    }
    await harness.drain();
    expect(harness.respondToRequest.mock.calls.map(([request]) => request)).toEqual([
      { threadId: "worker-a", requestId: "same-request", decision: "accept" },
      { threadId: "worker-b", requestId: "same-request", decision: "accept" },
    ]);
    expect(harness.respondToUserInput.mock.calls.map(([request]) => request)).toEqual([
      { threadId: "worker-a", requestId: "same-request", answers: { choice: "worker-a" } },
      { threadId: "worker-b", requestId: "same-request", answers: { choice: "worker-b" } },
    ]);
    expect((await harness.readModel()).threads).toHaveLength(1);
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("forwards structured question answers and their image attachments", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        images: [
          {
            questionId: "sandbox_mode",
            image: {
              type: "image",
              id: "question-image",
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
          },
        ],
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
      images: [
        {
          questionId: "sandbox_mode",
          image: {
            type: "image",
            id: "question-image",
            name: "photo.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        },
      ],
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("restores a lost async question only when the user submits an answer, without duplicating it", async () => {
    const resolved = Promise.withResolvers<void>();
    const harness = await createHarness({
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved"
        )
          resolved.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:recovered-question");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("recovered-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("recovered-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    for (const suffix of ["first", "retry"]) {
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(`recovered-answer-${suffix}`),
          threadId,
          requestId,
          answers: { question_1: "2023" },
          createdAt: now,
        }),
      );
      await harness.drain();
    }
    await resolved.promise;
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.messages.filter((message) => message.text.includes("Which year?\n2023")),
    ).toHaveLength(1);
    expect(
      thread?.activities.filter(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          (activity.payload as { requestId?: string }).requestId === requestId,
      ),
    ).toHaveLength(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a recovered question open until the provider accepts its answer", async () => {
    const entered = Promise.withResolvers<void>();
    const resolved = Promise.withResolvers<void>();
    const harness = await createHarness({
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved"
        )
          resolved.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:wait-for-acceptance");
    const now = "2026-01-01T00:00:00.000Z";
    const delivery = await harness.runEffect(
      Deferred.make<{ threadId: ThreadId; turnId: TurnId }>(),
    );
    harness.sendTurn.mockImplementation(() =>
      Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Deferred.await(delivery))),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("wait-question-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("wait-question-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("wait-question-answer"),
        threadId,
        requestId,
        answers: { question_1: "2023" },
        createdAt: now,
      }),
    );
    await entered.promise;
    let thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities.some((activity) => activity.kind === "user-input.resolved")).toBe(
      false,
    );
    await harness.runEffect(
      Deferred.succeed(delivery, { threadId, turnId: TurnId.make("accepted-turn") }),
    );
    await resolved.promise;
    thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "user-input.resolved",
        payload: expect.objectContaining({ requestId, recovered: true }),
      }),
    );
  });

  it("keeps a recovered question open if sending the answer fails", async () => {
    const failed = Promise.withResolvers<void>();
    const retryBlocked = Promise.withResolvers<void>();
    const harness = await createHarness({
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "provider.turn.start.failed"
        )
          failed.resolve();
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "provider.user-input.respond.failed"
        )
          retryBlocked.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:failed-delivery");
    const now = "2026-01-01T00:00:00.000Z";
    harness.sendTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "turn/start",
          detail: "Connection failed",
        }),
      ),
    );
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "item/tool/requestUserInput",
          detail: "Unknown pending Codex user input request: async:failed-delivery",
        }),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("failed-question-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("failed-question-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("failed-question-answer"),
        threadId,
        requestId,
        answers: { question_1: "2023" },
        createdAt: now,
      }),
    );
    await failed.promise;
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities.some((activity) => activity.kind === "user-input.resolved")).toBe(
      false,
    );
    expect(thread?.messages.some((message) => message.text.includes("Which year?\n2023"))).toBe(
      true,
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("failed-question-retry"),
        threadId,
        requestId,
        answers: { question_1: "2023" },
        createdAt: now,
      }),
    );
    await retryBlocked.promise;
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("does not mark the provider session failed when an accepted answer receipt cannot be saved", async () => {
    const failed = Promise.withResolvers<void>();
    const harness = await createHarness({
      failRecoveredReceipt: true,
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "provider.user-input.respond.failed"
        )
          failed.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:accepted-receipt-failed");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("receipt-question-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("receipt-question-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("receipt-question-answer"),
        threadId,
        requestId,
        answers: { question_1: "2023" },
        createdAt: now,
      }),
    );
    await failed.promise;
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(thread?.session?.status).not.toBe("error");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(false);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.user-input.respond.failed",
        payload: expect.objectContaining({
          requestId,
          detail: expect.stringContaining("수락했지만"),
        }),
      }),
    );
  });

  it("allows a corrected retry when recovered turn creation is definitively rejected", async () => {
    const failed = Promise.withResolvers<void>();
    const resolved = Promise.withResolvers<void>();
    const harness = await createHarness({
      rejectRecoveryStartOnce: true,
      onReactorCommandCommitted: (command) => {
        if (command.type !== "thread.activity.append") return;
        if (command.activity.kind === "provider.user-input.respond.failed") failed.resolve();
        if (command.activity.kind === "user-input.resolved") resolved.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:rejected-recovery-start");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("rejected-recovery-question"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("rejected-recovery-question"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    const answer = (id: string, value: string) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(id),
          threadId,
          requestId,
          answers: { question_1: value },
          createdAt: now,
        }),
      );
    await answer("rejected-recovery-answer-1", "2023");
    await failed.promise;
    let thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({ kind: "provider.user-input.recovery.not-sent" }),
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await answer("rejected-recovery-answer-2", "2024");
    await resolved.promise;
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "Which year?\n2024",
    );
    thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities.some((activity) => activity.kind === "user-input.resolved")).toBe(
      true,
    );
  });

  it("does not retry a recovered answer if turn creation failed with uncertain delivery", async () => {
    const failed = Promise.withResolvers<void>();
    const harness = await createHarness({
      uncertainRecoveryStartOnce: true,
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "provider.user-input.respond.failed"
        )
          failed.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:uncertain-recovery-start");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("uncertain-recovery-question"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("uncertain-recovery-question"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    for (const suffix of ["first", "retry"]) {
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(`uncertain-recovery-${suffix}`),
          threadId,
          requestId,
          answers: { question_1: "2023" },
          createdAt: now,
        }),
      );
      if (suffix === "first") await failed.promise;
      await harness.drain();
    }
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.some(
        (activity) => activity.kind === "provider.user-input.recovery.not-sent",
      ),
    ).toBe(false);
    expect(thread?.activities.some((activity) => activity.kind === "user-input.resolved")).toBe(
      false,
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("retries a recovered answer after a confirmed failure before provider delivery", async () => {
    const failed = Promise.withResolvers<void>();
    const resolved = Promise.withResolvers<void>();
    let starts = 0;
    const harness = await createHarness({
      startSessionEffect: (session) =>
        ++starts === 1
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: ProviderDriverKind.make("codex"),
                method: "session/start",
                detail: "Connection failed before delivery",
              }),
            )
          : Effect.succeed(session),
      onReactorCommandCommitted: (command) => {
        if (command.type !== "thread.activity.append") return;
        if (command.activity.kind === "provider.turn.start.failed") failed.resolve();
        if (command.activity.kind === "user-input.resolved") resolved.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:retry-before-delivery");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("retry-before-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("retry-before-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    const answer = (id: string, value: string) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(id),
          threadId,
          requestId,
          answers: { question_1: value },
          createdAt: now,
        }),
      );
    await answer("retry-before-first", "2023");
    await failed.promise;
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await answer("retry-before-second", "2024");
    await resolved.promise;
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "Which year?\n2024",
    );
    expect(decodeSentText(harness.sendTurn.mock.calls[0]?.[0]).input).toContain(
      "The previous answer was not delivered. Use this updated answer instead.",
    );
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({ kind: "provider.user-input.recovery.not-sent" }),
    );
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "user-input.resolved",
        payload: expect.objectContaining({ requestId, recovered: true }),
      }),
    );
  });

  it("recovers a missing async callback in a live idle session", async () => {
    const resolved = Promise.withResolvers<void>();
    const harness = await createHarness({
      onReactorCommandCommitted: (command) => {
        if (
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved"
        )
          resolved.resolve();
      },
    });
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:lost-callback");
    const now = "2026-01-01T00:00:00.000Z";
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      status: "ready",
      runtimeMode: "full-access",
      createdAt: now,
      updatedAt: now,
    });
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "item/tool/requestUserInput",
          detail: "Unknown pending Codex user input request: async:lost-callback",
        }),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("lost-callback-question"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("lost-callback-question"),
          kind: "user-input.requested",
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("lost-callback-session"),
        threadId,
        createdAt: now,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("lost-callback-answer"),
        threadId,
        requestId,
        answers: { question_1: "2023" },
        createdAt: now,
      }),
    );
    await harness.drain();
    await resolved.promise;
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "user-input.resolved",
        payload: expect.objectContaining({ requestId, recovered: true }),
      }),
    );
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.user-input.respond.failed"),
    ).toBe(false);
  });

  it.each(["unknown", "accepted"])(
    "does not resend an answer after %s prior delivery",
    async (outcome) => {
      const harness = await createHarness();
      const threadId = ThreadId.make("thread-1");
      const requestId = asApprovalRequestId("async:uncertain-question");
      const now = "2026-01-01T00:00:00.000Z";
      for (const [id, kind, payload] of [
        [
          "uncertain-question-request",
          "user-input.requested",
          { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        ],
        [
          "uncertain-question-delivery",
          "provider.user-input.delivery.started",
          { requestId, attemptId: "prior-attempt" },
        ],
      ] as const) {
        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(id),
            threadId,
            createdAt: now,
            activity: {
              id: EventId.make(id),
              kind,
              payload,
              tone: "info",
              summary: "Question",
              turnId: null,
              createdAt: now,
            },
          }),
        );
      }
      if (outcome === "accepted") {
        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("uncertain-delivery-finished"),
            threadId,
            createdAt: now,
            activity: {
              id: EventId.make("uncertain-delivery-finished"),
              kind: "provider.user-input.delivery.finished",
              payload: { requestId, attemptId: "prior-attempt", outcome: "accepted" },
              tone: "info",
              summary: "Delivered",
              turnId: null,
              createdAt: now,
            },
          }),
        );
      }
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make("uncertain-question-answer"),
          threadId,
          requestId,
          answers: { question_1: "2023" },
          createdAt: now,
        }),
      );
      await harness.drain();
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(thread?.activities).toContainEqual(
        expect.objectContaining({
          kind: "provider.user-input.respond.failed",
          payload: expect.objectContaining({
            detail: expect.stringContaining("중복 전송을 막기 위해"),
          }),
        }),
      );
    },
  );

  it("keeps an async question open when a recovered session is already working", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const requestId = asApprovalRequestId("async:busy-question");
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("busy-question-request"),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("busy-question-request"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Question",
          turnId: null,
          createdAt: now,
          payload: { requestId, questions: [{ id: "question_1", question: "Which year?" }] },
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("busy-question-session"),
        threadId,
        createdAt: now,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("existing-turn"),
          lastError: null,
          updatedAt: now,
        },
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("busy-question-answer"),
        threadId,
        requestId,
        answers: { question_1: "2023" },
        createdAt: now,
      }),
    );
    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(thread?.activities.some((activity) => activity.kind === "user-input.resolved")).toBe(
      false,
    );
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.user-input.respond.failed",
        payload: expect.objectContaining({
          detail: expect.stringContaining("현재 작업이 진행 중"),
        }),
      }),
    );
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});

describe("orchestraStopTargets", () => {
  const block = (runId: string, nodeId: string, status: string) => ({
    kind: "orchestra.block",
    payload: {
      executionId: `execution-${runId}`,
      ownerThreadId: "thread-1",
      runId,
      nodeId,
      attempt: 1,
      messageId: `message-${runId}`,
      title: "Block",
      displayName: "Block",
      role: "implementer",
      kind: "implementation",
      modelSelection: { instanceId: "codex", model: "gpt-6-sol" },
      status,
    },
  });

  it("cancels an orchestra run without interrupting a turn of the thread", () => {
    expect(
      orchestraStopTargets([
        block("run-1", "task-1", "running"),
        block("run-1", "task-2", "awaiting-user"),
        block("run-old", "task-1", "completed"),
        { kind: "tool.completed", payload: {} },
      ]),
    ).toEqual({ runIds: ["run-1"], delegating: false });
    expect(orchestraStopTargets([])).toEqual({ runIds: [], delegating: false });
  });

  it("also stops the thread's own turn while it delegates to a subordinate model", () => {
    expect(
      orchestraStopTargets([
        block("run-delegate", "delegate-worker", "running"),
        block("run-done", "delegate-advisor", "cancelled"),
      ]),
    ).toEqual({ runIds: ["run-delegate"], delegating: true });
    // A finished delegation leaves nothing to stop.
    expect(orchestraStopTargets([block("run-done", "delegate-scout", "completed")])).toEqual({
      runIds: [],
      delegating: false,
    });
  });
});
