import { makeWorkspaceWorkflow } from "./orchestration/WorkflowApi.ts";
import { WORKSPACE_WORKFLOW_WS_METHODS, WorkspaceWorkflowError } from "@t3tools/contracts";
import { WorkspaceWorkflowStore } from "./persistence/WorkspaceWorkflowStore.ts";
import { WORKSPACE_TASK_INBOX_WS_METHODS, WorkspaceTaskInboxError } from "@t3tools/contracts";
import { WorkspaceTaskInbox } from "./orchestration/WorkspaceTaskInbox.ts";
import { WORKSPACE_AGENT_CONTROL_WS_METHODS, WorkspaceAgentControlError } from "@t3tools/contracts";
import { WorkspaceAgentControl } from "./orchestration/WorkspaceAgentControl.ts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
  CommandId,
  type DiscoveredLocalServerList,
  EventId,
  type OrchestrationCommand,
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
  WORKSPACE_AUTOMATION_WS_METHODS,
  WORKSPACE_RESEARCH_WS_METHODS,
  WorkspaceResearchError,
  WorkspaceAutomationError,
  WorkspaceDevelopmentError,
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
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import { getManagedMcpToolCatalog } from "./mcp/ManagedMcpTools.ts";
import { getExtensionCatalog, manageExtension } from "./extensions/ExtensionManager.ts";
import {
  previewConversation,
  importConversation,
  exportConversation,
} from "./orchestration/ConversationTransfer.ts";
import { uploadDesignImage } from "./orchestration/DesignImageUpload.ts";
import { ExtensionError } from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
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
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceDevelopment } from "./orchestration/WorkspaceDevelopment.ts";
import { GrokResearch } from "./research/GrokResearch.ts";
import * as WorkspaceProgramSupervisor from "./orchestration/Services/WorkspaceProgramSupervisor.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
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
import { loginProviderAccount } from "./provider/ProviderAccountLogin.ts";
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
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5);

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  );

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Same bound for thread resume. The replay reads the *global* event range and
// filters per-thread afterwards, so a stale cursor far behind the head would
// otherwise decode every intervening event's payload — reconnects with cursors
// hundreds of thousands of events behind have OOM-killed servers on large
// databases. Past this gap the client is reset with a fresh thread snapshot.
const THREAD_RESUME_MAX_GAP = 1_000;

// Workspace runtime is a per-project state digest (which threads are working,
// blocked, or errored; run and schedule status). Every refresh reads the
// project's thread rows, so the subscription only wakes on events that can
// move that digest. Assistant streaming arrives as one thread.message-sent per
// delta — many per second — and none of them change it; nor do pin changes or
// diff completions. With a 75ms debounce the old subscription re-ran the
// query continuously for the whole turn, stacking queries faster than they
// finished and starving the event loop the chat stream shares.
const WORKSPACE_RUNTIME_INERT_THREAD_EVENTS: ReadonlySet<OrchestrationEvent["type"]> = new Set<
  OrchestrationEvent["type"]
>([
  "thread.message-sent",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.turn-diff-completed",
]);
const WORKSPACE_RUNTIME_REFRESH_DEBOUNCE = Duration.millis(500);

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

export const refreshGeminiProviderAfterAuth = Effect.fn("refreshGeminiProviderAfterAuth")(
  function* (
    instanceId: ProviderInstanceId,
    instanceRegistry: Pick<ProviderInstanceRegistry.ProviderInstanceRegistryShape, "getInstance">,
    providerRegistry: Pick<ProviderRegistry.ProviderRegistryShape, "refreshInstance">,
  ) {
    const instance = yield* instanceRegistry.getInstance(instanceId);
    if (instance?.driverKind === "gemini") {
      yield* instance.adapter.stopAll().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to stop Gemini provider sessions after account change", {
            instanceId,
            cause,
          }),
        ),
      );
    }
    yield* providerRegistry.refreshInstance(instanceId);
  },
);

export const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  transport: "websocket" | "desktop-direct" = "websocket",
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const developmentOption = yield* Effect.serviceOption(WorkspaceDevelopment);
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
        new WorkspaceResearchError({ message: "Grok 조사 서비스를 사용할 수 없습니다." }),
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
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
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
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
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
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
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
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
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
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
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

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
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

      const loadServerConfig = Effect.gen(function* () {
        const { keybindingsConfig, providers, settings, environment, auth, availableEditors } =
          yield* Effect.all(
            {
              keybindingsConfig: keybindings.loadConfigState,
              providers: providerRegistry.getProviders,
              settings: serverSettings.getSettings.pipe(
                Effect.map(ServerSettings.redactServerSettingsForClient),
              ),
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

      return WsRpcGroup.of({
        [WORKSPACE_RESEARCH_WS_METHODS.status]: (input) =>
          observeRpcEffect(
            WORKSPACE_RESEARCH_WS_METHODS.status,
            Option.isSome(research) ? research.value.status(input.projectId) : unavailableResearch,
          ),
        [WORKSPACE_RESEARCH_WS_METHODS.run]: (input) =>
          observeRpcEffect(
            WORKSPACE_RESEARCH_WS_METHODS.run,
            Option.isSome(research) ? research.value.run(input) : unavailableResearch,
          ),
        [WORKSPACE_RESEARCH_WS_METHODS.configureKey]: (input) =>
          observeRpcEffect(
            WORKSPACE_RESEARCH_WS_METHODS.configureKey,
            Option.isSome(research)
              ? research.value.configureKey(input.apiKey)
              : unavailableResearch,
          ),
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
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
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
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
                        message: "Failed to list Workspace knowledge",
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
        [WORKSPACE_DEVELOPMENT_WS_METHODS.get]: (input) =>
          observeRpcEffect(
            WORKSPACE_DEVELOPMENT_WS_METHODS.get,
            development.get(input.projectId).pipe(Effect.map((state) => ({ state }))),
          ),
        [WORKSPACE_AGENT_CONTROL_WS_METHODS.attention]: (input) =>
          observeRpcStream(
            WORKSPACE_AGENT_CONTROL_WS_METHODS.attention,
            Option.isSome(agentControl)
              ? agentControl.value.attention(input)
              : Stream.fromEffect(unavailableAgentControl),
          ),
        [WORKSPACE_AGENT_CONTROL_WS_METHODS.subscribe]: (input) =>
          observeRpcStream(
            WORKSPACE_AGENT_CONTROL_WS_METHODS.subscribe,
            Option.isSome(agentControl)
              ? agentControl.value.subscribe(input)
              : Stream.fromEffect(unavailableAgentControl),
          ),
        [WORKSPACE_AGENT_CONTROL_WS_METHODS.overview]: (input) =>
          observeRpcEffect(
            WORKSPACE_AGENT_CONTROL_WS_METHODS.overview,
            Option.isSome(agentControl)
              ? agentControl.value.overview(input)
              : unavailableAgentControl,
          ),
        [WORKSPACE_AGENT_CONTROL_WS_METHODS.action]: (input) =>
          observeRpcEffect(
            WORKSPACE_AGENT_CONTROL_WS_METHODS.action,
            Option.isSome(agentControl)
              ? agentControl.value.invoke(input)
              : unavailableAgentControl,
          ),
        [WORKSPACE_AGENT_CONTROL_WS_METHODS.evidence]: (input) =>
          observeRpcEffect(
            WORKSPACE_AGENT_CONTROL_WS_METHODS.evidence,
            Option.isSome(agentControl)
              ? agentControl.value.evidence(input)
              : unavailableAgentControl,
          ),
        [WORKSPACE_TASK_INBOX_WS_METHODS.subscribe]: (input) =>
          observeRpcStream(
            WORKSPACE_TASK_INBOX_WS_METHODS.subscribe,
            Option.isSome(taskInbox)
              ? taskInbox.value.subscribe(input.projectId)
              : Stream.fromEffect(unavailableInbox),
          ),
        [WORKSPACE_TASK_INBOX_WS_METHODS.overview]: (input) =>
          observeRpcEffect(
            WORKSPACE_TASK_INBOX_WS_METHODS.overview,
            Option.isSome(taskInbox) ? taskInbox.value.overview(input.projectId) : unavailableInbox,
          ),
        [WORKSPACE_TASK_INBOX_WS_METHODS.get]: (input) =>
          observeRpcEffect(
            WORKSPACE_TASK_INBOX_WS_METHODS.get,
            Option.isSome(taskInbox)
              ? taskInbox.value.get(input.projectId, input.taskId)
              : unavailableInbox,
          ),
        [WORKSPACE_TASK_INBOX_WS_METHODS.saveRecipe]: (input) =>
          observeRpcEffect(
            WORKSPACE_TASK_INBOX_WS_METHODS.saveRecipe,
            Option.isSome(taskInbox) ? taskInbox.value.saveRecipe(input) : unavailableInbox,
          ),
        [WORKSPACE_TASK_INBOX_WS_METHODS.submit]: (input) =>
          observeRpcEffect(
            WORKSPACE_TASK_INBOX_WS_METHODS.submit,
            Option.isSome(taskInbox) ? taskInbox.value.submit(input) : unavailableInbox,
          ),
        [WORKSPACE_TASK_INBOX_WS_METHODS.action]: (input) =>
          observeRpcEffect(
            WORKSPACE_TASK_INBOX_WS_METHODS.action,
            Option.isSome(taskInbox) ? taskInbox.value.action(input) : unavailableInbox,
          ),
        [WORKSPACE_AUTOMATION_WS_METHODS.overview]: (input) =>
          observeRpcEffect(
            WORKSPACE_AUTOMATION_WS_METHODS.overview,
            Effect.gen(function* () {
              if (
                !projectionSnapshotQuery.listWorkspaceCollaborationRuns ||
                !projectionSnapshotQuery.listWorkspaceSchedules
              ) {
                return yield* new WorkspaceAutomationError({
                  message: "자동 작업 성과 조회를 사용할 수 없습니다.",
                });
              }
              const [developmentState, runList, scheduleList] = yield* Effect.all(
                [
                  development.get(input.projectId),
                  projectionSnapshotQuery.listWorkspaceCollaborationRuns(input),
                  projectionSnapshotQuery.listWorkspaceSchedules(input),
                ],
                { concurrency: 3 },
              );
              const generatedAt = DateTime.formatIso(yield* DateTime.now);
              const base = automationOverview({
                projectId: input.projectId,
                generatedAt,
                runs: runList.runs,
                schedules: scheduleList.schedules,
                development: developmentState,
              });
              const selected = new Set(
                base.rows.filter((row) => row.source === "collaboration").map((row) => row.id),
              );
              const reports = yield* Effect.forEach(
                runList.runs.filter((run) => selected.has(`collaboration:${run.id}`)),
                (run) => {
                  const threadId = collaborationThread(run);
                  return threadId && projectionSnapshotQuery.getThreadTokenUsage
                    ? projectionSnapshotQuery
                        .getThreadTokenUsage({ threadId, workId: `run:${run.id}` })
                        .pipe(Effect.map((report) => [`run:${run.id}`, report] as const))
                    : Effect.succeed(null);
                },
                { concurrency: 4 },
              );
              const taskReports =
                developmentState && projectionSnapshotQuery.getThreadTokenUsage
                  ? yield* Effect.forEach(
                      developmentState.tasks.filter((task) =>
                        base.rows.some((row) => row.id === `development:${task.id}`),
                      ),
                      (task) =>
                        projectionSnapshotQuery.getThreadTokenUsage!({
                          threadId: developmentState.conversationId,
                          workId: `run:${task.goalId ? `development-goal:${task.goalId}` : task.runId}`,
                          nodeId: task.id,
                        }).pipe(
                          Effect.map((report) => [`development:${task.id}`, report] as const),
                        ),
                      { concurrency: 4 },
                    )
                  : [];
              return automationOverview({
                projectId: input.projectId,
                generatedAt,
                runs: runList.runs,
                schedules: scheduleList.schedules,
                development: developmentState,
                usage: new Map([...reports.filter((report) => report !== null), ...taskReports]),
              });
            }).pipe(
              Effect.mapError((cause) =>
                isWorkspaceAutomationError(cause)
                  ? cause
                  : new WorkspaceAutomationError({
                      message: "자동 작업 성과를 불러오지 못했습니다.",
                      cause,
                    }),
              ),
            ),
          ),
        [WORKSPACE_AUTOMATION_WS_METHODS.evidence]: (input) =>
          observeRpcEffect(
            WORKSPACE_AUTOMATION_WS_METHODS.evidence,
            development.get(input.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceAutomationError({
                    message: "검증 기록을 불러오지 못했습니다.",
                    cause,
                  }),
              ),
              Effect.flatMap((state) => readAutomationEvidence(state, input, config.dbPath)),
            ),
          ),
        [WORKSPACE_DEVELOPMENT_WS_METHODS.subscribe]: (input) =>
          observeRpcStream(
            WORKSPACE_DEVELOPMENT_WS_METHODS.subscribe,
            development.subscribe(input.projectId),
          ),
        [WORKSPACE_DEVELOPMENT_WS_METHODS.configure]: (input) =>
          observeRpcEffect(
            WORKSPACE_DEVELOPMENT_WS_METHODS.configure,
            development.configure(input),
          ),
        [WORKSPACE_DEVELOPMENT_WS_METHODS.directInput]: (input) =>
          observeRpcEffect(
            WORKSPACE_DEVELOPMENT_WS_METHODS.directInput,
            development.directInput(input),
          ),
        [WORKSPACE_DEVELOPMENT_WS_METHODS.returnControl]: (input) =>
          observeRpcEffect(
            WORKSPACE_DEVELOPMENT_WS_METHODS.returnControl,
            development.returnControl(input),
          ),
        [WORKSPACE_DEVELOPMENT_WS_METHODS.goal]: (input) =>
          observeRpcEffect(WORKSPACE_DEVELOPMENT_WS_METHODS.goal, development.goal(input)),
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
                maxItems: 1024,
                maxBytes: 4 * 1024 * 1024,
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
                maxItems: 1024,
                maxBytes: 4 * 1024 * 1024,
                overflow: (stats) =>
                  new OrchestrationGetSnapshotError({
                    message:
                      "Thread subscription exceeded its live buffer; resume from the last applied sequence.",
                    cause: stats,
                  }),
              });
              yield* Effect.forkScoped(liveStream.pipe(Stream.runForEach(liveBuffer.offer)));
              const bufferedLiveStream = liveBuffer.stream;

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
            getExtensionCatalog(input.workspaceRoot).pipe(
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
        [WS_METHODS.providerAccountLogin]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountLogin,
            loginProviderAccount(input).pipe(
              Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
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
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
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
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
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
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
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
    }),
  );

export const makeRpcHandlerLayer = (
  session: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  serverSelfUpdate: ServerSelfUpdate.ServerSelfUpdate["Service"],
  geminiAuth: GeminiAuth.GeminiAuth["Service"],
  transport: "websocket" | "desktop-direct" = "websocket",
) =>
  makeWsRpcLayer(session, previewAutomationBroker, transport).pipe(
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
            makeRpcHandlerLayer(session, previewAutomationBroker, serverSelfUpdate, geminiAuth),
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
