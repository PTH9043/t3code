import * as SqlClient from "effect/unstable/sql/SqlClient";
import { summarizeSavedToolActivity } from "./persistence/toolActivitySummary.ts";
import { factualToolActivitySummary } from "./toolActivitySummary.ts";
import { TelegramChannels } from "./telegram/service.ts";
import { TelegramChannelsError } from "@t3tools/contracts";
import { makeWorkspaceWorkflow } from "./orchestration/WorkflowApi.ts";
import { WORKSPACE_WORKFLOW_WS_METHODS, WorkspaceWorkflowError } from "@t3tools/contracts";
import { WorkspaceWorkflowStore } from "./persistence/WorkspaceWorkflowStore.ts";
import { WORKSPACE_TASK_INBOX_WS_METHODS, WorkspaceTaskInboxError } from "@t3tools/contracts";
import { WorkspaceTaskInbox } from "./orchestration/WorkspaceTaskInbox.ts";
import { WORKSPACE_AGENT_CONTROL_WS_METHODS, WorkspaceAgentControlError } from "@t3tools/contracts";
import { WorkspaceAgentControl } from "./orchestration/WorkspaceAgentControl.ts";
import { COUNCIL_WS_METHODS, CouncilError, MissionControlError } from "@t3tools/contracts";
import { CouncilOrchestratorService } from "./orchestration/council/CouncilOrchestrator.ts";
import { MissionOrchestratorService } from "./t3x/missionControl/MissionOrchestratorService.ts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import {
  knowledgeWriteCommand,
  legacyKnowledgeWriteCommand,
  userKnowledgeForkId,
} from "./orchestration/knowledgeDocuments.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { makeReplayBuffer } from "./stream/ReplayBuffer.ts";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  AssistantComputerControlError,
  AssistantComputerStatus,
  CommandId,
  type DiscoveredLocalServerList,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type WorkspaceKnowledgeEditInput,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationWorkspaceKnowledgeError,
  OrchestrationSharedLibraryError,
  OrchestrationWorkspaceAgentRolesError,
  OrchestrationWorkspaceCollaborationError,
  OrchestrationWorkspaceScheduleError,
  OrchestrationWorkspaceProgramError,
  OrchestrationWorkspaceRuntimeError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  WORKSPACE_DEVELOPMENT_WS_METHODS,
  WORKSPACE_MEMORY_WS_METHODS,
  WORKSPACE_AUTOMATION_WS_METHODS,
  WORKSPACE_RESEARCH_WS_METHODS,
  WorkspaceResearchError,
  WorkspaceAutomationError,
  WorkspaceDevelopmentError,
  WorkspaceMemoryError,
  type ProviderInstanceId,
  ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  TerminalProjectLookupError,
  TerminalProjectMismatchError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type OpenCodeConnectInput,
  type OpenAiApiListModelsInput,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import { getManagedMcpToolCatalog } from "./mcp/ManagedMcpTools.ts";
import {
  assistantComputerErrorMessage,
  assistantComputerRuntime,
} from "./assistant/assistantComputerRuntime.ts";
import { getExtensionCatalog, manageExtension } from "./extensions/ExtensionManager.ts";
import {
  previewConversation,
  importConversation,
  exportConversation,
} from "./orchestration/ConversationTransfer.ts";
import { uploadDesignImage } from "./orchestration/DesignImageUpload.ts";
import { ExtensionError } from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import { upgradeRoomAllowsRpc, upgradeRoomIds } from "./upgradeRoom.ts";
import { UpgradeRoomMemory, captureRoomMemory } from "./orchestration/UpgradeRoomMemory.ts";
import {
  automationOverview,
  collaborationThread,
  readAutomationEvidence,
  isWorkspaceAutomationError,
} from "./orchestration/workspaceAutomation.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import {
  discardAnswerAttemptImages,
  discardRejectedTurnAttachments,
  normalizeDispatchCommand,
} from "./orchestration/Normalizer.ts";
import { bootstrapCreateCommandId } from "./orchestration/turnRequestDigest.ts";
import type {
  BootstrapIdentity,
  BootstrapJournalEntry,
} from "./orchestration/bootstrapWorktreeJournal.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceDevelopment } from "./orchestration/WorkspaceDevelopment.ts";
import { WorkspaceMemory } from "./orchestration/WorkspaceMemory.ts";
import { GrokResearch } from "./research/GrokResearch.ts";
import * as WorkspaceProgramSupervisor from "./orchestration/Services/WorkspaceProgramSupervisor.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import { beginMuseAuth, cancelMuseAuth, waitMuseAuth } from "./provider/MuseAuth.ts";
import {
  beginMuseCloudAuth,
  cancelMuseCloudAuth,
  importMuseCloudCookies,
  waitMuseCloudAuth,
} from "./provider/MuseCloudAuth.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl, resolveRegisteredWorkspaceRootForAssetPath } from "./assets/AssetAccess.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as WorktreeProvisionService from "./git/WorktreeProvisionService.ts";
import { WorkspaceWorktreeCleanup } from "./orchestration/Layers/WorkspaceWorktreeCleanup.ts";
import { SharedLibrarySync } from "./library/SharedLibrarySync.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import type * as Scope from "effect/Scope";
import { makePdfRevisionRpc } from "./documents/pdfRevisionRpc.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as GeminiAuth from "./provider/GeminiAuth.ts";
import { connectDeepSeekAccount } from "./provider/DeepSeekConnection.ts";
import { connectAntseedAccount } from "./provider/AntseedConnection.ts";
import {
  beginGrokDeviceAuth,
  cancelGrokDeviceAuth,
  connectOpenCodeGoAccount,
  loginProviderAccount,
  waitGrokDeviceAuth,
} from "./provider/ProviderAccountLogin.ts";
import { listOpenAiApiModels } from "./provider/OpenAiApiModels.ts";
import { listLocalOllamaEmbeddingModels } from "./documents/OllamaEmbeddings.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import { makeKeyedLock } from "@t3tools/shared/KeyedLock";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const turnCommandLock = makeKeyedLock();
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);

import { makeWorkspaceRpcHandlers } from "./ws/wsWorkspaceHandlers.ts";
import {
  nowIso,
  decodeAssistantComputerStatus,
  resolveAvailableEditorsForConfig,
  projectEntriesFailureContext,
  filesystemBrowseFailureContext,
  projectFileFailureContext,
  projectSetupScriptCompatibilityDetail,
  isThreadDetailEvent,
  PROVIDER_STATUS_DEBOUNCE_MS,
  SHELL_RESUME_MAX_GAP,
  THREAD_RESUME_MAX_GAP,
  WORKSPACE_RUNTIME_INERT_THREAD_EVENTS,
  WORKSPACE_RUNTIME_REFRESH_DEBOUNCE,
  toAuthAccessStreamEvent,
  refreshGeminiProviderAfterAuth,
} from "./wsHelpers.ts";
export {
  isThreadDetailEvent,
  refreshGeminiProviderAfterAuth,
  resolveAvailableEditorsForConfig,
} from "./wsHelpers.ts";

export const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  pdfWorkerScope: Scope.Scope,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  transport: "websocket" | "desktop-direct" = "websocket",
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const developmentOption = yield* Effect.serviceOption(WorkspaceDevelopment);
      const workspaceMemory = yield* Effect.serviceOption(WorkspaceMemory);
      const upgradeMemory = yield* UpgradeRoomMemory;
      const unavailableDevelopment = Effect.fail(
        new WorkspaceDevelopmentError({
          message: "이 서버에는 지속 작업실 서비스가 활성화되어 있지 않습니다.",
        }),
      );
      const development: WorkspaceDevelopment["Service"] = Option.isSome(developmentOption)
        ? developmentOption.value
        : {
            get: () => Effect.succeed(null),
            subscribe: () => Stream.succeed({ state: null }),
            configure: () => unavailableDevelopment,
            directInput: () => unavailableDevelopment,
            returnControl: () => unavailableDevelopment,
            invoke: () => unavailableDevelopment,
            goal: () => unavailableDevelopment,
            prepareMainInput: (_, text) => Effect.succeed(text),
            workflowContext: () => Effect.succeed(""),
          };
      const librarySql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const workspaceProgramSupervisor = yield* Effect.serviceOption(
        WorkspaceProgramSupervisor.WorkspaceProgramSupervisor,
      );
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const workflowStore = yield* Effect.serviceOption(WorkspaceWorkflowStore);
      const unavailableWorkflow = Effect.fail(
        new WorkspaceWorkflowError({
          message: "이 서버에는 워크플로 서비스가 활성화되어 있지 않습니다.",
        }),
      );
      const workflow = Option.isSome(workflowStore)
        ? yield* makeWorkspaceWorkflow.pipe(
            Effect.provideService(WorkspaceWorkflowStore, workflowStore.value),
          )
        : {
            overview: () => unavailableWorkflow,
            getRun: () => unavailableWorkflow,
            skills: () => unavailableWorkflow,
            chatSkills: () => unavailableWorkflow,
            save: () => unavailableWorkflow,
            preview: () => unavailableWorkflow,
            start: () => unavailableWorkflow,
            control: () => unavailableWorkflow,
          };
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const worktreeProvision = yield* WorktreeProvisionService.WorktreeProvisionService;
      const worktreeCleanup = yield* WorkspaceWorktreeCleanup;
      const sharedLibrarySync = yield* Effect.serviceOption(SharedLibrarySync);
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerInstanceRegistry = yield* Effect.serviceOption(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
      );
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const geminiAuth = yield* GeminiAuth.GeminiAuth;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const telegram = yield* Effect.serviceOption(TelegramChannels);
      const unavailableTelegram = Effect.fail(
        new TelegramChannelsError({ detail: "이 환경의 텔레그램 서비스를 사용할 수 없습니다." }),
      );
      const pdfRevision = makePdfRevisionRpc(
        config,
        orchestrationEngine,
        librarySql,
        pdfWorkerScope,
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const agentControl = yield* Effect.serviceOption(WorkspaceAgentControl);
      const unavailableAgentControl = Effect.fail(
        new WorkspaceAgentControlError({ message: "작업자 메시지 서비스를 사용할 수 없습니다." }),
      );
      const taskInbox = yield* Effect.serviceOption(WorkspaceTaskInbox);
      const unavailableInbox = Effect.fail(
        new WorkspaceTaskInboxError({ message: "자동 업무 접수 서비스를 사용할 수 없습니다." }),
      );
      const research = yield* Effect.serviceOption(GrokResearch);
      const unavailableResearch = Effect.fail(
        new WorkspaceResearchError({ message: "API 조사 서비스를 사용할 수 없습니다." }),
      );
      const council = yield* Effect.serviceOption(CouncilOrchestratorService);
      const unavailableCouncil = Effect.fail(
        new CouncilError({
          code: "EXECUTION_FAILED",
          message: "다자간 위원회 서비스가 이 서버에 활성화되어 있지 않습니다.",
        }),
      );
      const missionControl = yield* Effect.serviceOption(MissionOrchestratorService);
      const unavailableMissionControl = Effect.fail(
        new MissionControlError({
          code: "UNAVAILABLE",
          message: "자율 미션 컨트롤 서비스가 이 서버에 활성화되어 있지 않습니다.",
        }),
      );
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const t3ProjectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(method, authorizeEffect(requiredScopeForRpcMethod(method), effect), {
          ...traceAttributes,
          "rpc.transport": transport,
        });
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(method, authorizeStream(requiredScopeForRpcMethod(method), stream), {
          ...traceAttributes,
          "rpc.transport": transport,
        });
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          { ...traceAttributes, "rpc.transport": transport },
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              ...(isOrchestrationCommandInvariantError(cause) &&
              cause.reason === "active-turn-settings"
                ? { reason: cause.reason }
                : isOrchestrationCommandPreviouslyRejectedError(cause) &&
                    cause.reason === "turn-request-id-conflict"
                  ? { reason: cause.reason }
                  : {}),
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return toDispatchCommandError(error, "Failed to bootstrap thread turn start.");
      };

      type ShellEvent = Pick<
        OrchestrationEvent,
        "type" | "sequence" | "aggregateKind" | "aggregateId"
      >;
      const shellEventEnvelope = (event: ShellEvent): ShellEvent => ({
        type: event.type,
        sequence: event.sequence,
        aggregateKind: event.aggregateKind,
        aggregateId: event.aggregateId,
      });
      const toShellStreamEvent = (
        event: ShellEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
          case "project.workspace-control-updated":
          case "project.runtime-viewed":
            return projectUpsertOrRemove(ProjectId.make(event.aggregateId), event.sequence);
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: ProjectId.make(event.aggregateId),
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: ThreadId.make(event.aggregateId),
              }),
            );
          case "thread.unarchived":
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
        }
      };

      // Coalescing makes each projection read represent every event for that
      // aggregate in the current window. Retry a typed persistence failure once
      // so a brief read failure cannot strand the shell at its previous state.
      // If both attempts fail, log and drop the stream item; treating an error as
      // a missing row would incorrectly remove a still-active aggregate.
      const retryShellProjectionRead = <A, E>(
        aggregateKind: "project" | "thread",
        aggregateId: string,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<Option.Option<A>, never, never> =>
        read.pipe(
          Effect.retry({ times: 1 }),
          Effect.map(Option.some),
          Effect.tapError((error) =>
            Effect.logWarning("orchestration shell projection refetch failed", {
              aggregateKind,
              aggregateId,
              error,
            }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );

      const projectUpsertOrRemove = (
        projectId: ProjectId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "project",
          projectId,
          projectionSnapshotQuery.getProjectShellById(projectId),
        ).pipe(
          Effect.map(
            Option.flatMap((project) =>
              Option.match(project, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-removed" as const,
                    sequence,
                    projectId,
                  }),
                onSome: (nextProject) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
              }),
            ),
          ),
        );

      // Refetch a thread's shell and emit an upsert if it is still active, or a
      // `thread-removed` if the projection has no active row for it. Emitting a
      // removal on a `none` (rather than dropping the event) is what keeps
      // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
      // into a later refetchable event for the same thread, the refetch returns
      // `none` for the now-inactive row and this still tells the sidebar to drop
      // it. A `thread-removed` the client does not have is a harmless no-op. The
      // projection commits in the same transaction before the event publishes,
      // so a `none` reliably means the thread is deleted or archived, not
      // not-yet-persisted.
      const threadUpsertOrRemove = (
        threadId: ThreadId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap((thread) =>
              Option.match(thread, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-removed" as const,
                    sequence,
                    threadId,
                  }),
                onSome: (nextThread) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-upserted" as const,
                    sequence,
                    thread: nextThread,
                  }),
              }),
            ),
          ),
        );

      // Turn a batch of domain events into shell stream items, coalescing by
      // aggregate first. `toShellStreamEvent` re-reads the *current* projected
      // shell for an aggregate, so within a batch only the latest event per
      // aggregate matters: a burst of streaming `thread.message-sent` deltas for
      // one thread collapses into a single shell refetch, and an unrelated
      // `thread.created` in the same batch is never stuck behind those DB reads.
      //
      // Input events arrive in ascending sequence; we keep the last (highest
      // sequence) event per aggregate, then re-sort ascending before emitting so
      // the client — which applies shell items strictly by increasing sequence
      // and drops any `sequence <= snapshotSequence` — never skips a coalesced
      // item. The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      const coalesceShellEvents = (
        events: ReadonlyArray<ShellEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
        Effect.gen(function* () {
          if (events.length === 0) {
            return [];
          }
          const latestByAggregate = new Map<string, ShellEvent>();
          for (const event of events) {
            latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
          }
          const survivors = Array.from(latestByAggregate.values()).sort(
            (left, right) => left.sequence - right.sequence,
          );
          const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        });

      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;
      const coalesceShellStream = <E, R>(
        stream: Stream.Stream<OrchestrationEvent, E, R>,
      ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
        stream.pipe(
          Stream.map(shellEventEnvelope),
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellEvents),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: ShellEvent }
        | { readonly kind: "synchronized" };

      // A completion marker is queued alongside raw live events so it cannot
      // overtake an event still waiting in the coalescing window. Split each
      // batch at markers and coalesce only the event segments on either side.
      const coalesceShellLiveInputs = (
        inputs: ReadonlyArray<ShellLiveInput>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const output: Array<OrchestrationShellStreamItem> = [];
          let pendingEvents: Array<ShellEvent> = [];

          for (const input of inputs) {
            if (input.kind === "event") {
              pendingEvents.push(input.event);
              continue;
            }

            output.push(...(yield* coalesceShellEvents(pendingEvents)));
            pendingEvents = [];
            output.push({ kind: "synchronized" });
          }

          output.push(...(yield* coalesceShellEvents(pendingEvents)));
          return output;
        });

      const coalesceShellLiveStream = <E, R>(
        stream: Stream.Stream<ShellLiveInput, E, R>,
      ): Stream.Stream<OrchestrationShellStreamItem, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellLiveInputs),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<
        { readonly sequence: number; readonly replayed?: true },
        OrchestrationDispatchCommandError
      > =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          if (command.requestFingerprint && orchestrationEngine.checkTurnReceipt) {
            const receipt = yield* orchestrationEngine
              .checkTurnReceipt({
                commandId: command.commandId,
                threadId: command.threadId,
                requestFingerprint: command.requestFingerprint,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "요청 접수 상태를 확인하지 못했습니다."),
                ),
              );
            if (receipt.status === "accepted") {
              return yield* orchestrationEngine
                .dispatch(finalTurnStartCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "기존 요청을 확인하지 못했습니다."),
                  ),
                );
            }
            if (receipt.status === "mismatch") {
              return yield* new OrchestrationDispatchCommandError({
                message: "같은 요청 ID에 다른 내용을 사용할 수 없습니다. 새 요청으로 보내세요.",
                reason: "turn-request-id-conflict",
              });
            }
          }
          let createdThread = false;
          let turnAttempted = false;
          let createCommandId: CommandId | undefined;
          const recoverableLocal = Boolean(
            bootstrap?.createThread &&
            !bootstrap.prepareWorktree &&
            !bootstrap.runSetupScript &&
            command.requestFingerprint &&
            orchestrationEngine.supportsOwnedBootstrapResume === true,
          );
          const recoverableWorktree = Boolean(
            bootstrap?.createThread &&
            bootstrap.prepareWorktree?.branch &&
            command.requestFingerprint &&
            orchestrationEngine.supportsOwnedBootstrapResume === true &&
            orchestrationEngine.bootstrapWorktreeJournal &&
            worktreeProvision.verifyExisting,
          );
          let journalIdentity: BootstrapIdentity | undefined;
          let journalEntry: BootstrapJournalEntry | undefined;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread && !recoverableWorktree
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                      ...(createCommandId ? { expectedCreationCommandId: createCommandId } : {}),
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return "no-script" as const;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              return yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }).pipe(Effect.as("failed" as const)),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.succeed("no-script" as const);
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      }).pipe(Effect.as("started" as const));
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (
              recoverableWorktree &&
              command.requestFingerprint &&
              orchestrationEngine.bootstrapWorktreeJournal
            ) {
              createCommandId = bootstrapCreateCommandId(command);
              journalIdentity = {
                commandId: command.commandId,
                threadId: command.threadId,
                requestFingerprint: command.requestFingerprint,
                creationCommandId: createCommandId,
              };
              journalEntry =
                yield* orchestrationEngine.bootstrapWorktreeJournal.begin(journalIdentity);
              if (journalEntry.phase === "provisioning" || journalEntry.phase === "setting-up") {
                return yield* new OrchestrationDispatchCommandError({
                  message:
                    "작업 트리 생성이나 설정 실행의 완료 여부가 불확실합니다. 기존 상태를 확인하세요.",
                  reason: "bootstrap-state-unknown",
                });
              }
            }
            if (bootstrap?.createThread) {
              createCommandId =
                recoverableLocal || recoverableWorktree
                  ? bootstrapCreateCommandId(command)
                  : yield* serverCommandId("bootstrap-thread-create");
              const creation = yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: createCommandId,
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = creation.replayed !== true;
            }

            if (bootstrap?.prepareWorktree) {
              if (
                journalEntry &&
                journalIdentity &&
                orchestrationEngine.bootstrapWorktreeJournal &&
                createCommandId
              ) {
                const shell = yield* projectionSnapshotQuery.getThreadShellById(command.threadId);
                if (Option.isNone(shell) || !bootstrap.createThread)
                  return yield* new OrchestrationDispatchCommandError({
                    message: "시작한 대화를 확인할 수 없습니다.",
                    reason: "bootstrap-state-unknown",
                  });
                const previousBranch = shell.value.branch;
                const previousPath = shell.value.worktreePath;
                const atOriginalLocation =
                  previousBranch === bootstrap.createThread.branch &&
                  previousPath === bootstrap.createThread.worktreePath;
                const atRecordedLocation =
                  journalEntry.worktreePath !== null &&
                  previousBranch === journalEntry.worktreeRef &&
                  previousPath === journalEntry.worktreePath;
                if (!atOriginalLocation && !atRecordedLocation)
                  return yield* new OrchestrationDispatchCommandError({
                    message: "대화의 브랜치 또는 작업 경로가 변경되어 자동으로 이어갈 수 없습니다.",
                    reason: "bootstrap-state-unknown",
                  });
                yield* orchestrationEngine.dispatch({
                  type: "thread.meta.update",
                  commandId: yield* serverCommandId("bootstrap-verify-owner"),
                  threadId: command.threadId,
                  bootstrapCreateClaim: createCommandId,
                  bootstrapExpectedBranch: previousBranch,
                  bootstrapExpectedWorktreePath: previousPath,
                });
                if (journalEntry.phase === "initial") {
                  journalEntry = yield* orchestrationEngine.bootstrapWorktreeJournal.advance(
                    journalIdentity,
                    { from: "initial", to: "provisioning" },
                  );
                  const created = yield* worktreeProvision.provision({
                    projectCwd: bootstrap.prepareWorktree.projectCwd,
                    baseBranch: bootstrap.prepareWorktree.baseBranch,
                    branch: bootstrap.prepareWorktree.branch ?? null,
                    startFromOrigin: bootstrap.prepareWorktree.startFromOrigin,
                  });
                  if (created.refName !== bootstrap.prepareWorktree.branch)
                    return yield* new OrchestrationDispatchCommandError({
                      message: "생성된 작업 트리의 브랜치가 요청과 다릅니다.",
                      reason: "bootstrap-state-unknown",
                    });
                  journalEntry = yield* orchestrationEngine.bootstrapWorktreeJournal.advance(
                    journalIdentity,
                    {
                      from: "provisioning",
                      to: "worktree-ready",
                      worktreePath: created.worktreePath,
                      worktreeRef: created.refName,
                    },
                  );
                } else {
                  const verified =
                    journalEntry.worktreePath &&
                    journalEntry.worktreeRef &&
                    worktreeProvision.verifyExisting
                      ? yield* worktreeProvision.verifyExisting({
                          projectCwd: bootstrap.prepareWorktree.projectCwd,
                          worktreePath: journalEntry.worktreePath,
                          branch: journalEntry.worktreeRef,
                        })
                      : false;
                  if (!verified)
                    return yield* new OrchestrationDispatchCommandError({
                      message: "저장된 작업 트리가 원래 브랜치에 연결돼 있는지 확인할 수 없습니다.",
                      reason: "bootstrap-state-unknown",
                    });
                }
                if (!journalEntry.worktreePath || !journalEntry.worktreeRef)
                  return yield* new OrchestrationDispatchCommandError({
                    message: "작업 트리 기록이 불완전합니다.",
                    reason: "bootstrap-state-unknown",
                  });
                targetWorktreePath = journalEntry.worktreePath;
                if (!atRecordedLocation) {
                  yield* orchestrationEngine.dispatch({
                    type: "thread.meta.update",
                    commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                    threadId: command.threadId,
                    bootstrapCreateClaim: createCommandId,
                    bootstrapExpectedBranch: previousBranch,
                    bootstrapExpectedWorktreePath: previousPath,
                    branch: journalEntry.worktreeRef,
                    worktreePath: journalEntry.worktreePath,
                  });
                }
                yield* refreshGitStatus(targetWorktreePath);
              } else {
                const provisioned = yield* worktreeProvision.provision({
                  projectCwd: bootstrap.prepareWorktree.projectCwd,
                  baseBranch: bootstrap.prepareWorktree.baseBranch,
                  branch: bootstrap.prepareWorktree.branch ?? null,
                  startFromOrigin: bootstrap.prepareWorktree.startFromOrigin,
                });
                targetWorktreePath = provisioned.worktreePath;
                yield* orchestrationEngine.dispatch({
                  type: "thread.meta.update",
                  commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                  threadId: command.threadId,
                  branch: provisioned.refName,
                  worktreePath: targetWorktreePath,
                });
                yield* refreshGitStatus(targetWorktreePath);
              }
            }

            if (
              journalEntry &&
              journalIdentity &&
              orchestrationEngine.bootstrapWorktreeJournal &&
              bootstrap?.runSetupScript
            ) {
              if (journalEntry.phase === "worktree-ready") {
                journalEntry = yield* orchestrationEngine.bootstrapWorktreeJournal.advance(
                  journalIdentity,
                  { from: "worktree-ready", to: "setting-up" },
                );
                const setupOutcome = yield* runSetupProgram();
                journalEntry = yield* orchestrationEngine.bootstrapWorktreeJournal.advance(
                  journalIdentity,
                  { from: "setting-up", to: "setup-finished", setupOutcome },
                );
              }
            } else if (!journalEntry) yield* runSetupProgram();

            turnAttempted = true;
            return yield* orchestrationEngine.dispatch({
              ...finalTurnStartCommand,
              ...((recoverableLocal || recoverableWorktree) && createCommandId
                ? { bootstrapCreateClaim: createCommandId }
                : {}),
              ...(journalEntry?.worktreePath && journalEntry.worktreeRef
                ? {
                    bootstrapExpectedBranch: journalEntry.worktreeRef,
                    bootstrapExpectedWorktreePath: journalEntry.worktreePath,
                  }
                : {}),
            });
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const baseError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(baseError);
              }
              const failure = Cause.squash(cause);
              const definitivelyUncommitted =
                !turnAttempted ||
                isOrchestrationCommandInvariantError(failure) ||
                isOrchestrationCommandPreviouslyRejectedError(failure);
              const dispatchError =
                definitivelyUncommitted && baseError.reason === undefined
                  ? new OrchestrationDispatchCommandError({
                      message: baseError.message,
                      reason: "bootstrap-precommit-rejected",
                      cause: baseError,
                    })
                  : baseError;
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const appendMeetingUserMessage = (input: {
        readonly projectId: ProjectId;
        readonly threadId: import("@t3tools/contracts").ThreadId;
        readonly commandId: CommandId;
        readonly messageId: import("@t3tools/contracts").MessageId;
        readonly text: string;
        readonly createdAt: string;
      }) =>
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.user.append",
            commandId: CommandId.make(`${input.commandId}:meeting-message`),
            threadId: input.threadId,
            messageId: input.messageId,
            text: input.text,
            createdAt: input.createdAt,
          });
          if (Option.isSome(workspaceMemory)) {
            const [project, thread] = yield* Effect.all([
              projectionSnapshotQuery.getProjectShellById(input.projectId),
              projectionSnapshotQuery.getThreadRuntimeContext(input.threadId),
            ]);
            if (Option.isSome(project) && Option.isSome(thread))
              yield* workspaceMemory.value
                .contextPaths({
                  projectId: input.projectId,
                  threadId: input.threadId,
                  messageId: input.messageId,
                  cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
                  recordCurrent: true,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("추가 지시의 폴더 범위를 기록하지 못했습니다.", { cause }),
                  ),
                );
          }
        });

      const writeKnowledgeDocument = (
        input: Pick<WorkspaceKnowledgeEditInput, "projectId" | "itemId" | "commandId">,
        edit?: WorkspaceKnowledgeEditInput,
      ) =>
        Effect.gen(function* () {
          const resolve = projectionSnapshotQuery.knowledgeWriteResult;
          if (!resolve)
            return yield* new OrchestrationWorkspaceKnowledgeError({
              message: "Knowledge writer unavailable.",
            });
          const command = knowledgeWriteCommand(
            input,
            edit ? { mode: "edit", edit } : { mode: "restore" },
            yield* nowIso,
          );
          const { sequence } = yield* orchestrationEngine.dispatch(command);
          const itemId = yield* resolve(input.projectId, input.commandId, sequence);
          if (
            !itemId ||
            (itemId !== input.itemId && (!edit || itemId !== userKnowledgeForkId(input.itemId)))
          ) {
            return yield* new OrchestrationWorkspaceKnowledgeError({
              message: "Knowledge write receipt did not match the document.",
            });
          }
          return { sequence, itemId };
        }).pipe(
          Effect.mapError(
            (cause) => new OrchestrationWorkspaceKnowledgeError({ message: cause.message, cause }),
          ),
        );

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<
        { readonly sequence: number; readonly replayed?: true },
        OrchestrationDispatchCommandError
      > => {
        const dispatchEffect = Effect.gen(function* () {
          if (
            normalizedCommand.type === "thread.turn.interrupt" &&
            normalizedCommand.questionRequestId === undefined &&
            projectionSnapshotQuery.listWorkspaceCollaborationRuns
          ) {
            const thread = yield* projectionSnapshotQuery.getThreadRuntimeContext(
              normalizedCommand.threadId,
            );
            if (Option.isSome(thread)) {
              const { runs } = yield* projectionSnapshotQuery.listWorkspaceCollaborationRuns({
                projectId: thread.value.projectId,
                statuses: ["queued", "running"],
              });
              const run = runs.find(
                (candidate) =>
                  candidate.meeting?.threadId === normalizedCommand.threadId &&
                  ["queued", "running"].includes(candidate.status),
              );
              if (run)
                return yield* orchestrationEngine.dispatch({
                  type: "project.collaboration.run.cancel",
                  commandId: normalizedCommand.commandId,
                  projectId: run.projectId,
                  runId: run.id,
                  createdAt: normalizedCommand.createdAt,
                });
            }
          }
          if (
            normalizedCommand.type === "thread.turn.start" &&
            !normalizedCommand.bootstrap?.createThread &&
            projectionSnapshotQuery.listWorkspaceCollaborationRuns
          ) {
            const thread = yield* projectionSnapshotQuery.getThreadRuntimeContext(
              normalizedCommand.threadId,
            );
            if (Option.isSome(thread)) {
              const { runs } = yield* projectionSnapshotQuery.listWorkspaceCollaborationRuns({
                projectId: thread.value.projectId,
                statuses: ["queued", "running", "cancel-requested"],
              });
              const run = runs.find(
                (candidate) =>
                  candidate.meeting?.threadId === normalizedCommand.threadId &&
                  ["queued", "running", "cancel-requested"].includes(candidate.status),
              );
              if (run) {
                if (run.status === "cancel-requested")
                  return yield* new OrchestrationDispatchCommandError({
                    message: "통합 작업이 중지되는 중입니다. 중지가 끝난 뒤 다시 보내세요.",
                  });
                if (normalizedCommand.inputOrigin === "automation")
                  return yield* new OrchestrationDispatchCommandError({
                    message:
                      "통합 작업이 진행 중인 대화에는 자동 일반 메시지를 시작할 수 없습니다.",
                  });
                const text = normalizedCommand.message.text.trim();
                if (
                  !text ||
                  text.length > 8_000 ||
                  normalizedCommand.message.attachments.length > 0
                )
                  return yield* new OrchestrationDispatchCommandError({
                    message: "통합 작업 중에는 8,000자 이하의 텍스트로 감독 AI에게 지시하세요.",
                  });
                const pending = run.meeting?.pendingQuestion;
                const stop =
                  /^(애|얘|야)?\s*(회의|미팅|오케스트라)?\s*(멈춰|멈춰라|멈춰줘|멈추라고|중지|중지해|중지해줘|중단|중단해|중단해줘|그만|그만해|그만해라|스탑|스톱|stop|cancel)[\s.!?~…ㅋㅎ;,]*$/iu.test(
                    text,
                  );
                const result = yield* orchestrationEngine.dispatch(
                  stop
                    ? {
                        type: "project.collaboration.run.cancel",
                        commandId: normalizedCommand.commandId,
                        projectId: run.projectId,
                        runId: run.id,
                        createdAt: normalizedCommand.createdAt,
                      }
                    : pending
                      ? {
                          type: "project.collaboration.run.answer",
                          commandId: normalizedCommand.commandId,
                          projectId: run.projectId,
                          runId: run.id,
                          question: pending.question,
                          questionRef: { nodeId: pending.nodeId, askedAt: pending.askedAt },
                          answer: text,
                          createdAt: normalizedCommand.createdAt,
                        }
                      : {
                          type: "project.collaboration.run.interject",
                          commandId: normalizedCommand.commandId,
                          projectId: run.projectId,
                          runId: run.id,
                          text,
                          createdAt: normalizedCommand.createdAt,
                        },
                );
                yield* appendMeetingUserMessage({
                  projectId: run.projectId,
                  threadId: normalizedCommand.threadId,
                  commandId: normalizedCommand.commandId,
                  messageId: normalizedCommand.message.messageId,
                  text: normalizedCommand.message.text,
                  createdAt: normalizedCommand.createdAt,
                });
                return result;
              }
            }
          }
          if (
            (normalizedCommand.type === "project.collaboration.run.interject" ||
              normalizedCommand.type === "project.collaboration.run.answer") &&
            projectionSnapshotQuery.listWorkspaceCollaborationRuns
          ) {
            const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
              Effect.tapError((cause) =>
                normalizedCommand.type === "project.collaboration.run.answer" &&
                (isOrchestrationCommandInvariantError(cause) ||
                  isOrchestrationCommandPreviouslyRejectedError(cause))
                  ? discardAnswerAttemptImages(normalizedCommand).pipe(
                      Effect.provideService(FileSystem.FileSystem, fileSystem),
                      Effect.provideService(ServerConfig.ServerConfig, config),
                      Effect.catch((error) =>
                        Effect.logWarning("Could not remove rejected answer images", { error }),
                      ),
                    )
                  : Effect.void,
              ),
            );
            if (normalizedCommand.type === "project.collaboration.run.answer" && result.replayed)
              yield* discardAnswerAttemptImages(normalizedCommand).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(ServerConfig.ServerConfig, config),
                Effect.catch((error) =>
                  Effect.logWarning("Could not remove duplicate answer images", { error }),
                ),
              );
            const { runs } = yield* projectionSnapshotQuery.listWorkspaceCollaborationRuns({
              projectId: normalizedCommand.projectId,
              runId: normalizedCommand.runId,
            });
            const run = runs.find((candidate) => candidate.id === normalizedCommand.runId);
            if (!run?.meeting?.threadId) return result;
            yield* appendMeetingUserMessage({
              projectId: run.projectId,
              threadId: run.meeting.threadId,
              commandId: normalizedCommand.commandId,
              messageId: MessageId.make(`meeting-message:${normalizedCommand.commandId}`),
              text:
                normalizedCommand.type === "project.collaboration.run.answer"
                  ? normalizedCommand.answer
                  : normalizedCommand.text,
              createdAt: normalizedCommand.createdAt,
            });
            return result;
          }
          if (normalizedCommand.type === "thread.turn.start") {
            return yield* turnCommandLock.withKey(
              normalizedCommand.commandId,
              normalizedCommand.bootstrap
                ? dispatchBootstrapTurnStart(normalizedCommand)
                : orchestrationEngine
                    .dispatch(normalizedCommand)
                    .pipe(
                      Effect.mapError((cause) =>
                        toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                      ),
                    ),
            );
          }
          return yield* orchestrationEngine.dispatch(normalizedCommand);
        }).pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
          ),
        );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const publicSettings = (settings: import("@t3tools/contracts").ServerSettings) =>
        config.upgradeRoom
          ? providerRegistry.getProviders.pipe(
              Effect.map((providers) => ({
                ...ServerSettings.redactServerSettingsForClient(settings),
                providerAutoSwitch: { codex: false, claudeAgent: false },
                providerInstances: Object.fromEntries(
                  providers.map((provider) => [
                    provider.instanceId,
                    {
                      driver: provider.driver,
                      enabled: provider.enabled,
                      displayName: provider.displayName,
                      config: {
                        customModels: provider.models.filter((m) => m.isCustom).map((m) => m.slug),
                      },
                    },
                  ]),
                ),
              })),
            )
          : Effect.succeed(ServerSettings.redactServerSettingsForClient(settings));

      const loadServerConfig = Effect.gen(function* () {
        const { keybindingsConfig, providers, settings, environment, auth, availableEditors } =
          yield* Effect.all(
            {
              keybindingsConfig: keybindings.loadConfigState,
              providers: providerRegistry.getProviders,
              settings: serverSettings.getSettings.pipe(Effect.flatMap(publicSettings)),
              environment: serverEnvironment.getDescriptor,
              auth: serverAuth.getDescriptor(),
              availableEditors: resolveAvailableEditorsForConfig(
                externalLauncher.resolveAvailableEditors(),
              ),
            },
            { concurrency: "unbounded" },
          );

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          ...(config.upgradeRoom ? { upgradeRoom: upgradeRoomIds } : {}),
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors,
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
        };
      });

      const resolveTerminalAccessContext = Effect.fn("ws.resolveTerminalAccessContext")(function* (
        input: {
          readonly threadId: string;
          readonly terminalId: string;
          readonly projectId?: string | undefined;
        },
        clientId: string,
      ) {
        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(ThreadId.make(input.threadId))
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalProjectLookupError({
                  threadId: input.threadId,
                  cause,
                }),
            ),
          );
        if (Option.isNone(thread)) {
          return yield* new TerminalProjectLookupError({
            threadId: input.threadId,
          });
        }

        const projectId = thread.value.projectId;
        if (input.projectId !== undefined && input.projectId !== projectId) {
          return yield* new TerminalProjectMismatchError({
            threadId: input.threadId,
            terminalId: input.terminalId,
            expectedProjectId: input.projectId,
            actualProjectId: projectId,
          });
        }
        return { clientId, projectId };
      });

      const terminalMutationAccessContext = (
        input: { readonly projectId?: string | undefined },
        clientId: string,
      ): TerminalManager.TerminalAccessContext => ({
        clientId,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const handlers = WsRpcGroup.of({
        ...makeWorkspaceRpcHandlers({
          observeRpcEffect,
          observeRpcStream,
          research,
          unavailableResearch,
          council,
          unavailableCouncil,
          missionControl,
          unavailableMissionControl,
          workspaceMemory,
          upgradeMemory,
          development,
          agentControl,
          unavailableAgentControl,
          taskInbox,
          unavailableInbox,
          projectionSnapshotQuery,
          config,
        }),
        [ORCHESTRATION_WS_METHODS.checkTurnReceipt]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.checkTurnReceipt,
            (
              orchestrationEngine.checkTurnReceipt?.(input) ??
              Effect.succeed({ status: "unconfirmed" as const })
            ).pipe(
              Effect.map((result) => ({
                ...result,
                safeBootstrapReplay: orchestrationEngine.checkTurnReceipt !== undefined,
                safeBootstrapResume: orchestrationEngine.supportsOwnedBootstrapResume === true,
                safeWorktreeBootstrapResume:
                  orchestrationEngine.supportsOwnedBootstrapResume === true &&
                  typeof orchestrationEngine.bootstrapWorktreeJournal?.begin === "function" &&
                  typeof orchestrationEngine.bootstrapWorktreeJournal?.advance === "function" &&
                  typeof worktreeProvision.verifyExisting === "function",
              })),
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "요청 접수 상태를 확인하지 못했습니다."),
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalized = yield* normalizeDispatchCommand(command);
              const normalizedCommand: OrchestrationCommand =
                normalized.type === "project.knowledge.item.upsert"
                  ? legacyKnowledgeWriteCommand(normalized)
                  : normalized;
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.orElseSucceed(() => false),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand).pipe(
                Effect.tapError((error) =>
                  normalizedCommand.type === "thread.turn.start" &&
                  (error.reason === "active-turn-settings" ||
                    error.reason === "turn-request-id-conflict" ||
                    error.reason === "bootstrap-precommit-rejected" ||
                    error.reason === "bootstrap-state-unknown")
                    ? discardRejectedTurnAttachments(normalizedCommand).pipe(
                        Effect.catch((cause) =>
                          Effect.logWarning("Could not remove rejected turn attachments", {
                            cause,
                          }),
                        ),
                      )
                    : Effect.void,
                ),
              );
              if (normalizedCommand.type === "thread.turn.start" && result.replayed) {
                yield* discardRejectedTurnAttachments(normalizedCommand).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not remove duplicate turn attachments", { cause }),
                  ),
                );
              }
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkflowScript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkflowScript,
            readWorkflowScript({ scriptPath: input.scriptPath }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getSharedLibraryStatus]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getSharedLibraryStatus,
            sharedLibrarySync._tag === "None"
              ? Effect.fail(
                  new OrchestrationSharedLibraryError({
                    message: "공용 라이브러리를 사용할 수 없습니다",
                  }),
                )
              : sharedLibrarySync.value.status().pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationSharedLibraryError({
                        message: "공용 라이브러리 상태를 읽지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.syncSharedLibrary]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.syncSharedLibrary,
            sharedLibrarySync._tag === "None"
              ? Effect.fail(
                  new OrchestrationSharedLibraryError({
                    message: "공용 라이브러리를 사용할 수 없습니다",
                  }),
                )
              : Effect.gen(function* () {
                  const started = yield* sharedLibrarySync.value.syncNow();
                  const status = yield* sharedLibrarySync.value.status();
                  return { started, status };
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationSharedLibraryError({
                        message: "공용 라이브러리 동기화를 시작하지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.cleanupWorkspaceWorktree]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.cleanupWorkspaceWorktree,
            worktreeCleanup
              .cleanupByRef(input)
              .pipe(
                Effect.tap((result) =>
                  result.status === "removed" ? refreshGitStatus(input.worktreePath) : Effect.void,
                ),
              ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard,
            projectionSnapshotQuery.getWorkspaceKnowledgeDashboard?.(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationWorkspaceKnowledgeError({
                    message: "Failed to read knowledge dashboard",
                    cause,
                  }),
              ),
            ) ??
              Effect.fail(
                new OrchestrationWorkspaceKnowledgeError({
                  message: "Knowledge dashboard unavailable",
                }),
              ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkspaceWikiLinks]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkspaceWikiLinks,
            projectionSnapshotQuery.getWorkspaceWikiLinks?.(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationWorkspaceKnowledgeError({
                    message: "Failed to read workspace wiki links",
                    cause,
                  }),
              ),
            ) ??
              Effect.fail(
                new OrchestrationWorkspaceKnowledgeError({
                  message: "Workspace wiki links unavailable",
                }),
              ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.getPdfRevisionStatus]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getPdfRevisionStatus,
            pdfRevision.getPdfRevisionStatus(input),
            {
              "rpc.aggregate": "orchestration",
              "rpc.workspace_id": input.projectId,
            },
          ),
        [ORCHESTRATION_WS_METHODS.startPdfRevision]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.startPdfRevision,
            pdfRevision.startPdfRevision(input),
            {
              "rpc.aggregate": "orchestration",
              "rpc.workspace_id": input.projectId,
            },
          ),
        [ORCHESTRATION_WS_METHODS.retryPdfRevision]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.retryPdfRevision,
            pdfRevision.retryPdfRevision(input),
            {
              "rpc.aggregate": "orchestration",
              "rpc.workspace_id": input.projectId,
            },
          ),
        [ORCHESTRATION_WS_METHODS.readPdfRevisionSource]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.readPdfRevisionSource,
            pdfRevision.readPdfRevisionSource(input),
            {
              "rpc.aggregate": "orchestration",
              "rpc.workspace_id": input.projectId,
            },
          ),
        [ORCHESTRATION_WS_METHODS.editWorkspaceKnowledge]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.editWorkspaceKnowledge,
            writeKnowledgeDocument(input, input),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.restoreWorkspaceKnowledge]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.restoreWorkspaceKnowledge,
            writeKnowledgeDocument(input),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceKnowledgeRevisions]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceKnowledgeRevisions,
            projectionSnapshotQuery
              .listWorkspaceKnowledgeRevisions?.(input)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationWorkspaceKnowledgeError({ message: cause.message, cause }),
                ),
              ) ??
              Effect.fail(
                new OrchestrationWorkspaceKnowledgeError({
                  message: "문서 변경 이력을 불러올 수 없습니다.",
                }),
              ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeRevision]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeRevision,
            projectionSnapshotQuery
              .getWorkspaceKnowledgeRevision?.(input)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationWorkspaceKnowledgeError({ message: cause.message, cause }),
                ),
              ) ??
              Effect.fail(
                new OrchestrationWorkspaceKnowledgeError({
                  message: "문서 변경 이력을 불러올 수 없습니다.",
                }),
              ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge,
            projectionSnapshotQuery.listWorkspaceKnowledge === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceKnowledgeError({
                    message: "프로젝트 지식 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspaceKnowledge(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceKnowledgeError({
                        message:
                          input.includeArchiveSnapshot && cause instanceof Error
                            ? cause.message
                            : "Failed to list Workspace knowledge",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.getThreadTokenUsage]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getThreadTokenUsage,
            projectionSnapshotQuery.getThreadTokenUsage === undefined
              ? Effect.fail(
                  new OrchestrationSearchThreadsError({
                    message: "사용량 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.getThreadTokenUsage(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationSearchThreadsError({
                        message: "사용량 조회에 실패했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.thread_id": input.threadId },
          ),
        [ORCHESTRATION_WS_METHODS.searchWorkspaceRag]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchWorkspaceRag,
            projectionSnapshotQuery.searchWorkspaceRag === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceKnowledgeError({
                    message: "프로젝트 RAG 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.searchWorkspaceRag(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceKnowledgeError({
                        message: "Failed to search Workspace RAG",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.composeWorkspacePrompt]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.composeWorkspacePrompt,
            projectionSnapshotQuery.composeWorkspacePrompt === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceKnowledgeError({
                    message: "프로젝트 프롬프트 결합을 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.composeWorkspacePrompt(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceKnowledgeError({
                        message: "Failed to compose Workspace prompt",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceAgentRoles]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceAgentRoles,
            projectionSnapshotQuery.listWorkspaceAgentRoles === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceAgentRolesError({
                    message: "프로젝트 에이전트 역할 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspaceAgentRoles(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceAgentRolesError({
                        message: "Failed to list Workspace agent roles",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceCollaborationRuns]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceCollaborationRuns,
            projectionSnapshotQuery.listWorkspaceCollaborationRuns === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceCollaborationError({
                    message: "프로젝트 협업 실행 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspaceCollaborationRuns(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceCollaborationError({
                        message: "Failed to list Workspace collaboration runs",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceSchedules]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceSchedules,
            projectionSnapshotQuery.listWorkspaceSchedules === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceScheduleError({
                    message: "프로젝트 스케줄 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspaceSchedules(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceScheduleError({
                        message: "Failed to list Workspace schedules",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkspaceRuntime]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkspaceRuntime,
            projectionSnapshotQuery.getWorkspaceRuntime === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceRuntimeError({
                    message: "프로젝트 실행 상태 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.getWorkspaceRuntime(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceRuntimeError({
                        message: "프로젝트 실행 상태를 불러오지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeWorkspaceRuntime]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeWorkspaceRuntime,
            Effect.sync(() => {
              const loadRuntime =
                projectionSnapshotQuery.getWorkspaceRuntime === undefined
                  ? Effect.fail(
                      new OrchestrationWorkspaceRuntimeError({
                        message: "프로젝트 실행 상태 구독을 사용할 수 없습니다",
                      }),
                    )
                  : projectionSnapshotQuery.getWorkspaceRuntime(input).pipe(
                      Effect.mapError(
                        (cause) =>
                          new OrchestrationWorkspaceRuntimeError({
                            message: "프로젝트 실행 상태를 불러오지 못했습니다",
                            cause,
                          }),
                      ),
                    );
              // Thread events carry no projectId, so ownership is resolved once
              // per thread and remembered for the life of the subscription.
              // `null` marks a thread that is not ours (or is gone) so it is
              // not looked up again. thread.created is the one event that
              // names its project and seeds the map without a query.
              const threadProjectIds = new Map<ThreadId, ProjectId | null>();
              const isThisProjectThreadEvent = (event: OrchestrationEvent) => {
                if (event.type === "thread.created") {
                  threadProjectIds.set(event.payload.threadId, event.payload.projectId);
                  return Effect.succeed(event.payload.projectId === input.projectId);
                }
                const threadId = event.aggregateId as ThreadId;
                const known = threadProjectIds.get(threadId);
                if (known !== undefined) {
                  return Effect.succeed(known === input.projectId);
                }
                return projectionSnapshotQuery.getThreadShellById(threadId).pipe(
                  Effect.map((shell) => {
                    const projectId = Option.isSome(shell) ? shell.value.projectId : null;
                    threadProjectIds.set(threadId, projectId);
                    return projectId === input.projectId;
                  }),
                  Effect.orElseSucceed(() => false),
                );
              };
              const live = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter((event) =>
                  event.aggregateKind === "project"
                    ? event.aggregateId === input.projectId
                    : event.aggregateKind === "thread" &&
                      !WORKSPACE_RUNTIME_INERT_THREAD_EVENTS.has(event.type),
                ),
                Stream.filterEffect((event) =>
                  event.aggregateKind === "project"
                    ? Effect.succeed(true)
                    : isThisProjectThreadEvent(event),
                ),
                Stream.debounce(WORKSPACE_RUNTIME_REFRESH_DEBOUNCE),
                Stream.mapEffect(() => loadRuntime),
              );
              return Stream.concat(Stream.fromEffect(loadRuntime), live).pipe(Stream.changes);
            }),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.discoverWorkspacePrograms]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.discoverWorkspacePrograms,
            Option.isNone(workspaceProgramSupervisor)
              ? Effect.fail(
                  new OrchestrationWorkspaceProgramError({
                    message: "프로젝트 프로그램 검색을 사용할 수 없습니다",
                  }),
                )
              : workspaceProgramSupervisor.value.discover(input.projectId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceProgramError({
                        message: "프로젝트 프로그램 후보를 찾지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspacePrograms]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspacePrograms,
            projectionSnapshotQuery.listWorkspacePrograms === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceProgramError({
                    message: "프로젝트 프로그램 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspacePrograms(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceProgramError({
                        message: "프로젝트 프로그램을 불러오지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceProgramRuns]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceProgramRuns,
            projectionSnapshotQuery.listWorkspaceProgramRuns === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceProgramError({
                    message: "프로젝트 프로그램 실행 기록 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspaceProgramRuns(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceProgramError({
                        message: "프로젝트 프로그램 실행 기록을 불러오지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.listWorkspaceIncidents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listWorkspaceIncidents,
            projectionSnapshotQuery.listWorkspaceIncidents === undefined
              ? Effect.fail(
                  new OrchestrationWorkspaceProgramError({
                    message: "프로젝트 오류 보고 조회를 사용할 수 없습니다",
                  }),
                )
              : projectionSnapshotQuery.listWorkspaceIncidents(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationWorkspaceProgramError({
                        message: "프로젝트 오류 보고를 불러오지 못했습니다",
                        cause,
                      }),
                  ),
                ),
            { "rpc.aggregate": "orchestration", "rpc.workspace_id": input.projectId },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBuffer = yield* makeReplayBuffer<
                ShellLiveInput,
                OrchestrationGetSnapshotError
              >({
                maxItems: 4096,
                maxBytes: 16 * 1024 * 1024,
                overflow: (stats) =>
                  new OrchestrationGetSnapshotError({
                    message:
                      "Shell subscription exceeded its live buffer; resume from the last applied sequence.",
                    cause: stats,
                  }),
              });
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.runForEach((event) =>
                    liveBuffer.offer({ kind: "event" as const, event: shellEventEnvelope(event) }),
                  ),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = coalesceShellLiveStream(liveBuffer.stream);

              const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBuffer
                          .offer({ kind: "synchronized" as const })
                          .pipe(
                            Effect.andThen(liveBuffer.takeAll),
                            Effect.flatMap(coalesceShellLiveInputs),
                          ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (replayGap < 0 || replayGap > SHELL_RESUME_MAX_GAP) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event),
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* makeReplayBuffer<
                OrchestrationThreadStreamItem,
                OrchestrationGetSnapshotError
              >({
                maxItems: 4096,
                maxBytes: 16 * 1024 * 1024,
                overflow: (stats) =>
                  new OrchestrationGetSnapshotError({
                    message:
                      "Thread subscription exceeded its live buffer; resume from the last applied sequence.",
                    cause: stats,
                  }),
              });
              yield* Effect.forkScoped(liveStream.pipe(Stream.runForEach(liveBuffer.offer)));
              // Keep every detail event in order, but let the RPC transport
              // send a burst in one frame instead of one frame per event.
              const batchedLiveStream = liveBuffer.stream.pipe(
                Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
                Stream.flattenIterable,
              );
              // Drain the single-item replay buffer through the marker first.
              // The marker must not wait for the live batching window, and no
              // event published before it may be delivered after it.
              const bufferedLiveStream = input.requestCompletionMarker
                ? Stream.concat(
                    liveBuffer.stream.pipe(
                      Stream.takeUntil((item) => item.kind === "synchronized"),
                    ),
                    batchedLiveStream,
                  )
                : batchedLiveStream;

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // The replay is bounded to the projection head captured below. The
              // catch-up range is normally tiny (a fresh HTTP snapshot sequence),
              // but a stale cached cursor can sit hundreds of thousands of global
              // events behind — replaying that decodes every intervening event
              // (including every other thread's tool payloads) only to discard
              // almost all of them, which has OOM-killed servers on large
              // databases. A truncated replay would silently drop this thread's
              // events, so past the gap cap we reset the client with a fresh
              // thread snapshot instead, exactly like subscribeShell above.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= THREAD_RESUME_MAX_GAP) {
                  const catchUpStream = orchestrationEngine
                    .readEvents(afterSequence, replayGap)
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  const afterCatchUp =
                    input.requestCompletionMarker === true
                      ? Stream.concat(
                          Stream.fromEffect(
                            liveBuffer.offer({ kind: "synchronized" as const }),
                          ).pipe(Stream.drain),
                          bufferedLiveStream,
                        )
                      : bufferedLiveStream;
                  return Stream.concat(catchUpStream, afterCatchUp);
                }
                // Gap too large (or cursor ahead of authoritative state): fall
                // through to the snapshot path so the client converges from a
                // fresh thread detail instead of an unbounded replay.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(
                  input.threadId,
                  // Windowing the fallback snapshot is opt-in per subscription:
                  // clients that don't send turnLimit (including all
                  // pre-pagination clients) get the full thread, since they
                  // have no way to load older pages.
                  input.turnLimit === undefined ? undefined : { turnLimit: input.turnLimit },
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const afterSnapshot =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(liveBuffer.offer({ kind: "synchronized" as const })).pipe(
                        Stream.drain,
                      ),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(snapshot.value),
                }),
                afterSnapshot,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WORKSPACE_WORKFLOW_WS_METHODS.overview]: (input) => workflow.overview(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.getRun]: (input) => workflow.getRun(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.skills]: (input) => workflow.skills(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.chatSkills]: (input) => workflow.chatSkills(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.preview]: (input) => workflow.preview(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.save]: (input) => workflow.save(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.start]: (input) => workflow.start(input),
        [WORKSPACE_WORKFLOW_WS_METHODS.control]: (input) => workflow.control(input),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetMcpTools]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetMcpTools,
            getManagedMcpToolCatalog(input.check === true, input.workspaceRoot).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetExtensions]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetExtensions,
            getExtensionCatalog(input.workspaceRoot, input.providerInstanceId).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
              Effect.mapError((cause) => new ExtensionError({ message: cause.message })),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverManageExtension]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverManageExtension,
            manageExtension(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.conversationPreview]: (input) =>
          observeRpcEffect(WS_METHODS.conversationPreview, previewConversation(input)),
        [WS_METHODS.conversationImport]: (input) =>
          observeRpcEffect(
            WS_METHODS.conversationImport,
            importConversation(input).pipe(
              Effect.provideService(
                ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                projectionSnapshotQuery,
              ),
              Effect.provideService(
                OrchestrationEngine.OrchestrationEngineService,
                orchestrationEngine,
              ),
            ),
          ),
        [WS_METHODS.conversationExport]: (input) =>
          observeRpcEffect(
            WS_METHODS.conversationExport,
            exportConversation(input).pipe(
              Effect.provideService(
                ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                projectionSnapshotQuery,
              ),
            ),
          ),
        [WS_METHODS.designImageUpload]: (input) =>
          observeRpcEffect(
            WS_METHODS.designImageUpload,
            uploadDesignImage(input).pipe(
              Effect.provideService(
                ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                projectionSnapshotQuery,
              ),
            ),
          ),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.geminiAuthBegin]: (input) =>
          observeRpcEffect(WS_METHODS.geminiAuthBegin, geminiAuth.begin(input.instanceId), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.deepSeekConnect]: (input) =>
          observeRpcEffect(
            WS_METHODS.deepSeekConnect,
            connectDeepSeekAccount(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.antseedConnect]: (input) =>
          observeRpcEffect(
            WS_METHODS.antseedConnect,
            connectAntseedAccount(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.openCodeConnect]: (input: OpenCodeConnectInput) =>
          observeRpcEffect(
            WS_METHODS.openCodeConnect,
            connectOpenCodeGoAccount(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.openAiApiListModels]: (input: OpenAiApiListModelsInput) =>
          observeRpcEffect(
            WS_METHODS.openAiApiListModels,
            listOpenAiApiModels(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.aiSearchListEmbeddingModels]: (input) =>
          observeRpcEffect(
            WS_METHODS.aiSearchListEmbeddingModels,
            listLocalOllamaEmbeddingModels(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "aiSearch",
            },
          ),
        [WS_METHODS.providerAccountLogin]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountLogin,
            loginProviderAccount(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
              Effect.tap((result) =>
                providerRegistry.refreshInstance(result.instanceId).pipe(Effect.ignore),
              ),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.grokDeviceAuthBegin]: (input) =>
          observeRpcEffect(
            WS_METHODS.grokDeviceAuthBegin,
            beginGrokDeviceAuth(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.grokDeviceAuthWait]: (input) =>
          observeRpcEffect(
            WS_METHODS.grokDeviceAuthWait,
            waitGrokDeviceAuth(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
              Effect.tap((result) =>
                providerRegistry.refreshInstance(result.instanceId).pipe(Effect.ignore),
              ),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.grokDeviceAuthCancel]: (input) =>
          observeRpcEffect(WS_METHODS.grokDeviceAuthCancel, cancelGrokDeviceAuth(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.museAuthBegin]: (input) =>
          observeRpcEffect(
            WS_METHODS.museAuthBegin,
            beginMuseAuth(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.museAuthWait]: (input) =>
          observeRpcEffect(
            WS_METHODS.museAuthWait,
            waitMuseAuth(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
              Effect.tap((result) =>
                providerRegistry.refreshInstance(result.instanceId).pipe(Effect.ignore),
              ),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.museAuthCancel]: (input) =>
          observeRpcEffect(WS_METHODS.museAuthCancel, cancelMuseAuth(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.museCloudAuthBegin]: (input) =>
          observeRpcEffect(
            WS_METHODS.museCloudAuthBegin,
            beginMuseCloudAuth(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.museCloudAuthWait]: (input) =>
          observeRpcEffect(
            WS_METHODS.museCloudAuthWait,
            waitMuseCloudAuth(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
              Effect.tap((result) =>
                providerRegistry.refreshInstance(result.instanceId).pipe(Effect.ignore),
              ),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.museCloudAuthCancel]: (input) =>
          observeRpcEffect(WS_METHODS.museCloudAuthCancel, cancelMuseCloudAuth(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.museCloudAuthImportCookies]: (input) =>
          observeRpcEffect(
            WS_METHODS.museCloudAuthImportCookies,
            importMuseCloudCookies(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
              Effect.tap((result) =>
                providerRegistry.refreshInstance(result.instanceId).pipe(Effect.ignore),
              ),
            ),
            {
              "rpc.aggregate": "providerAuth",
            },
          ),
        [WS_METHODS.geminiAuthComplete]: (input) =>
          observeRpcEffect(
            WS_METHODS.geminiAuthComplete,
            geminiAuth.complete(input.sessionId, input.code).pipe(
              Effect.tap((result) =>
                Option.match(providerInstanceRegistry, {
                  onNone: () => providerRegistry.refreshInstance(result.instanceId),
                  onSome: (instanceRegistry) =>
                    refreshGeminiProviderAfterAuth(
                      result.instanceId,
                      instanceRegistry,
                      providerRegistry,
                    ),
                }),
              ),
            ),
            { "rpc.aggregate": "providerAuth" },
          ),
        [WS_METHODS.geminiAuthCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.geminiAuthCancel,
            geminiAuth.cancel(input.sessionId).pipe(Effect.as({})),
            { "rpc.aggregate": "providerAuth" },
          ),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverSelfUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverSelfUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.telegramChannelsStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.telegramChannelsStatus,
            Option.isSome(telegram) ? telegram.value.status(input) : unavailableTelegram,
            { "rpc.aggregate": "telegram" },
          ),
        [WS_METHODS.telegramChannelsManage]: (input) =>
          observeRpcEffect(
            WS_METHODS.telegramChannelsManage,
            Option.isSome(telegram) ? telegram.value.manage(input) : unavailableTelegram,
            { "rpc.aggregate": "telegram" },
          ),
        [WS_METHODS.serverSummarizeToolActivity]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSummarizeToolActivity,
            Option.isSome(librarySql)
              ? summarizeSavedToolActivity(librarySql.value, input).pipe(
                  Effect.provideService(ServerConfig.ServerConfig, config),
                )
              : Effect.succeed(factualToolActivitySummary),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.flatMap(publicSettings)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.assistantComputerControl]: ({ threadId, command }) =>
          Effect.gen(function* () {
            const thread = yield* projectionSnapshotQuery
              .getThreadShellById(threadId)
              .pipe(
                Effect.mapError(
                  () =>
                    new AssistantComputerControlError({ message: "대화를 확인하지 못했습니다." }),
                ),
              );
            if (Option.isNone(thread))
              return yield* new AssistantComputerControlError({
                message: "대화를 찾을 수 없습니다.",
              });
            const result = yield* Effect.tryPromise({
              try: () => assistantComputerRuntime(serverSettings).invoke(threadId, command),
              catch: (cause) =>
                new AssistantComputerControlError({
                  message: assistantComputerErrorMessage(cause),
                }),
            });
            return yield* decodeAssistantComputerStatus(result).pipe(
              Effect.mapError(
                () =>
                  new AssistantComputerControlError({
                    message: "비서 컴퓨터 상태를 확인하지 못했습니다.",
                  }),
              ),
            );
          }),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadT3File]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadT3File,
            // No error channel beyond authorization: a workspace without a
            // `t3.json` is a project that declares nothing, which is an answer
            // rather than a fault. The loader already reports genuine read and
            // decode failures on its own and yields none.
            t3ProjectFileLoader
              .load(input.cwd)
              .pipe(Effect.map((projectFile) => ({ projectFile: Option.getOrNull(projectFile) }))),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (input.resource._tag !== "workspace-file") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const primaryWorkspaceRoot = thread.value.worktreePath ?? project.value.workspaceRoot;
              const requestedPath = input.resource.path.trim();
              const isAbsoluteAssetPath =
                requestedPath.startsWith("/") ||
                /^[A-Za-z]:[\\/]/.test(requestedPath) ||
                requestedPath.startsWith("\\\\");
              const registeredWorkspaceRoots = isAbsoluteAssetPath
                ? yield* projectionSnapshotQuery.getSnapshot().pipe(
                    Effect.map((snapshot) =>
                      snapshot.projects
                        .filter((entry) => entry.deletedAt === null)
                        .map((entry) => entry.workspaceRoot),
                    ),
                    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
                  )
                : [];
              const resolvedWorkspaceRoot = resolveRegisteredWorkspaceRootForAssetPath({
                primaryWorkspaceRoot,
                requestedPath,
                registeredWorkspaceRoots,
              });
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: resolvedWorkspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.reviewGetDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffFileContents,
            review.getDiffFileContents(input),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.terminalOpen]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalOpen,
            resolveTerminalAccessContext(input, String(metadata.client.id)).pipe(
              Effect.flatMap((accessContext) => terminalManager.open(input, accessContext)),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalAttach]: (input, metadata) =>
          observeRpcStreamEffect(
            WS_METHODS.terminalAttach,
            resolveTerminalAccessContext(input, String(metadata.client.id)).pipe(
              Effect.map((accessContext) =>
                Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
                  Effect.acquireRelease(
                    terminalManager.attachStream(
                      input,
                      (event) => Queue.offer(queue, event),
                      accessContext,
                    ),
                    (unsubscribe) => Effect.sync(unsubscribe),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalWrite,
            terminalManager.write(
              input,
              terminalMutationAccessContext(input, String(metadata.client.id)),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalResize]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalResize,
            terminalManager.resize(
              input,
              terminalMutationAccessContext(input, String(metadata.client.id)),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalClear]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalClear,
            terminalManager.clear(
              input,
              terminalMutationAccessContext(input, String(metadata.client.id)),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalRestart]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalRestart,
            resolveTerminalAccessContext(input, String(metadata.client.id)).pipe(
              Effect.flatMap((accessContext) => terminalManager.restart(input, accessContext)),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalClose]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalClose,
            terminalManager.close(
              input,
              terminalMutationAccessContext(input, String(metadata.client.id)),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan();
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                });
                yield* portDiscovery.subscribe((servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, { servers, scannedAt });
                  }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.mapEffect(publicSettings),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
      const room = config.upgradeRoom;
      if (!room) return handlers;
      return new Proxy(handlers, {
        get(target, key, receiver) {
          const handle = Reflect.get(target, key, receiver);
          if (typeof key !== "string" || typeof handle !== "function") return handle;
          return (input: unknown, ...rest: unknown[]) =>
            upgradeRoomAllowsRpc(key, input, room.projectRoot)
              ? Reflect.apply(handle, target, [input, ...rest])
              : Effect.fail(
                  new EnvironmentAuthorizationError({
                    message: "전용 업그레이드 방에서 허용되지 않는 요청입니다.",
                    requiredScope: requiredScopeForRpcMethod(key),
                  }),
                );
        },
      });
    }),
  );

export const makeRpcHandlerLayer = (
  session: EnvironmentAuth.AuthenticatedSession,
  pdfWorkerScope: Scope.Scope,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  serverSelfUpdate: ServerSelfUpdate.ServerSelfUpdate["Service"],
  geminiAuth: GeminiAuth.GeminiAuth["Service"],
  transport: "websocket" | "desktop-direct" = "websocket",
) =>
  makeWsRpcLayer(session, pdfWorkerScope, previewAutomationBroker, transport).pipe(
    Layer.provideMerge(RpcSerialization.layerJson),
    Layer.provide(ProviderMaintenanceRunner.layer),
    Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
    Layer.provide(Layer.succeed(GeminiAuth.GeminiAuth, geminiAuth)),
    Layer.provide(
      SourceControlDiscovery.layer.pipe(
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                AzureDevOpsCli.layer,
                BitbucketApi.layer,
                GitHubCli.layer,
                GitLabCli.layer,
              ),
            ),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
        Layer.provide(VcsProcess.layer),
      ),
    ),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const pdfWorkerScope = yield* Effect.scope;
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const geminiAuth = yield* GeminiAuth.GeminiAuth;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeRpcHandlerLayer(
              session,
              pdfWorkerScope,
              previewAutomationBroker,
              serverSelfUpdate,
              geminiAuth,
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
