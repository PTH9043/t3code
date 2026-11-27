import {
  COUNCIL_WS_METHODS,
  CouncilAbortInput,
  CouncilApproveOverrideInput,
  CouncilError,
  CouncilExecutePinnedSpecInput,
  CouncilExecutePinnedSpecResult,
  CouncilGetSessionInput,
  CouncilListThreadSessionsInput,
  CouncilListThreadSessionsResult,
  CouncilReverifyPinnedSpecInput,
  CouncilSessionSnapshot,
  CouncilStartAutoSeatInput,
  CouncilStreamEvent,
  CouncilSubscribeInput,
  CouncilTriageInput,
  CouncilTriageResult,
} from "./council.ts";
import {
  MISSION_CONTROL_WS_METHODS,
  MissionCancelInput,
  MissionDeleteInput,
  MissionControlError,
  MissionControlSnapshot,
  MissionControlStreamEvent,
  MissionCreateInput,
  MissionCrewRole,
  MissionCrewRoleDeleteInput,
  MissionCrewRoleUpsertInput,
  MissionDecideApprovalInput,
  MissionDigestNowInput,
  MissionGetSnapshotInput,
  MissionHeartbeatCheckInput,
  MissionHeartbeatCheckResult,
  MissionInspectArtifactInput,
  MissionInspectArtifactResult,
  MissionKillSwitchInput,
  MissionMeetingActionInput,
  MissionMeetingRecord,
  MissionPromoteMeetingInput,
  MissionReport,
  MissionRoundtableStartInput,
  MissionRun,
  MissionSubscribeInput,
  MissionSyncMeetingInput,
  MissionSynapsePruneInput,
} from "./missionControl.ts";
import {
  WORKSPACE_MEMORY_WS_METHODS,
  WorkspaceMemoryError,
  WorkspaceMemoryForgetInput,
  WorkspaceMemoryRememberInput,
} from "./workspaceMemory.ts";
import {
  WORKSPACE_TASK_INBOX_WS_METHODS,
  WorkspaceTaskInboxLookup,
  WorkspaceTaskInboxOverview,
  WorkspaceTaskLookup,
  WorkspaceInboxTask,
  WorkspaceTaskInboxError,
  WorkspaceTaskRecipeSave,
  WorkspaceTaskRecipe,
  WorkspaceTaskSubmit,
  WorkspaceTaskAction,
} from "./workspaceTaskInbox.ts";
import {
  WORKSPACE_AGENT_CONTROL_WS_METHODS,
  WorkspaceAttentionLookup,
  WorkspaceAttentionOverview,
  WorkspaceAgentControlLookup,
  WorkspaceAgentControlOverview,
  WorkspaceAgentControlAction,
  WorkspaceAgentControlEvidenceInput,
  WorkspaceAgentControlEvidence,
  WorkspaceAgentControlError,
} from "./workspaceAgentControl.ts";
import {
  WORKSPACE_WORKFLOW_WS_METHODS,
  WorkflowLookup,
  WorkflowChatSkillLookup,
  WorkflowChatSkillCatalog,
  WorkflowSave,
  WorkflowPreview,
  WorkflowPreviewResult,
  WorkflowStart,
  WorkflowControl,
  WorkflowOverview,
  WorkflowSkillCatalog,
  WorkflowRunLookup,
  WorkspaceWorkflowError,
} from "./workspaceWorkflow.ts";
import { WorkflowVersion } from "./workflowGraph.ts";
import { WorkspaceCollaborationRun } from "./orchestration.ts";
import * as Schema from "effect/Schema";
import {
  WORKSPACE_RESEARCH_WS_METHODS,
  WorkspaceResearchLookup,
  WorkspaceResearchInput,
  WorkspaceResearchCall,
  WorkspaceResearchStatus,
  WorkspaceResearchKeyInput,
  WorkspaceResearchError,
} from "./workspaceResearch.ts";
import {
  WORKSPACE_AUTOMATION_WS_METHODS,
  WorkspaceAutomationLookup,
  WorkspaceAutomationOverview,
  WorkspaceAutomationEvidenceInput,
  WorkspaceAutomationEvidence,
  WorkspaceAutomationError,
} from "./workspaceAutomation.ts";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { McpToolCatalog, McpToolsError } from "./mcpTools.ts";
import {
  ExtensionLookup,
  ExtensionCatalog,
  ExtensionActionInput,
  ExtensionError,
} from "./extensions.ts";
import {
  ConversationPreviewInput,
  ConversationPreview,
  ConversationImportInput,
  ConversationExportInput,
  ConversationExport,
  ConversationTransferError,
} from "./conversationTransfer.ts";
import { ThreadId } from "./baseSchemas.ts";
import { ToolActivitySummaryInput, ToolActivitySummaryResult } from "./toolActivitySummary.ts";
import {
  TelegramChannelsError,
  TelegramChannelsManageInput,
  TelegramChannelsStatusInput,
  TelegramChannelsStatusResult,
} from "./telegramChannels.ts";
import { DesignImageUploadInput, DesignImageUploadError } from "./designReference.ts";
import {
  DeepSeekConnectInput,
  DeepSeekConnectResult,
  DeepSeekConnectionError,
} from "./deepSeekConnection.ts";
import {
  AntseedConnectInput,
  AntseedConnectResult,
  AntseedConnectionError,
} from "./antseedConnection.ts";
import {
  GrokDeviceAuthBeginInput,
  GrokDeviceAuthBeginResult,
  GrokDeviceAuthCancelInput,
  GrokDeviceAuthWaitInput,
  MuseAuthBeginInput,
  MuseAuthBeginResult,
  MuseAuthCancelInput,
  MuseAuthWaitInput,
  MuseCloudAuthBeginInput,
  MuseCloudAuthBeginResult,
  MuseCloudAuthCancelInput,
  MuseCloudAuthCookieInput,
  MuseCloudAuthWaitInput,
  ProviderAccountLoginError,
  ProviderAccountLoginInput,
  ProviderAccountLoginResult,
} from "./providerAccountLogin.ts";
import {
  OpenCodeConnectInput,
  OpenCodeConnectResult,
  OpenCodeConnectionError,
} from "./openCodeConnection.ts";
import {
  AiSearchListEmbeddingModelsError,
  AiSearchListEmbeddingModelsInput,
  AiSearchListEmbeddingModelsResult,
} from "./aiSearch.ts";
import {
  OpenAiApiListModelsError,
  OpenAiApiListModelsInput,
  OpenAiApiListModelsResult,
} from "./openAiApiAccount.ts";
import {
  WORKSPACE_DEVELOPMENT_WS_METHODS,
  WorkspaceDevelopmentConfigure,
  WorkspaceDevelopmentDirectInput,
  WorkspaceDevelopmentError,
  WorkspaceDevelopmentLookup,
  WorkspaceDevelopmentReturnControl,
  WorkspaceDevelopmentSnapshot,
  WorkspaceDevelopmentState,
  WorkspaceDevelopmentGoalInput,
} from "./workspaceDevelopment.ts";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  GeminiAuthBeginInput,
  GeminiAuthBeginResult,
  GeminiAuthCancelInput,
  GeminiAuthCompleteInput,
  GeminiAuthCompleteResult,
  GeminiAuthError,
} from "./geminiAuth.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationWorkspaceKnowledgeError,
  OrchestrationWorkspaceAgentRolesError,
  OrchestrationWorkspaceCollaborationError,
  OrchestrationWorkspaceScheduleError,
  OrchestrationWorkspaceProgramError,
  OrchestrationWorkspaceRuntimeError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationGetWorkflowScriptError,
  OrchestrationWorktreeCleanupError,
  OrchestrationSharedLibraryError,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectReadT3FileInput,
  ProjectReadT3FileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsReadT3File: "projects.readT3File",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverGetMcpTools: "server.getMcpTools",
  serverGetExtensions: "server.getExtensions",
  serverManageExtension: "server.manageExtension",
  conversationPreview: "conversation.preview",
  conversationImport: "conversation.import",
  conversationExport: "conversation.export",
  designImageUpload: "design.imageUpload",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  geminiAuthBegin: "geminiAuth.begin",
  deepSeekConnect: "deepseek.connect",
  antseedConnect: "antseed.connect",
  openCodeConnect: "opencode.connect",
  openAiApiListModels: "openAiApi.listModels",
  aiSearchListEmbeddingModels: "aiSearch.listEmbeddingModels",
  providerAccountLogin: "providerAccount.login",
  grokDeviceAuthBegin: "grokDeviceAuth.begin",
  grokDeviceAuthWait: "grokDeviceAuth.wait",
  grokDeviceAuthCancel: "grokDeviceAuth.cancel",
  museAuthBegin: "museAuth.begin",
  museAuthWait: "museAuth.wait",
  museAuthCancel: "museAuth.cancel",
  museCloudAuthBegin: "museCloudAuth.begin",
  museCloudAuthWait: "museCloudAuth.wait",
  museCloudAuthCancel: "museCloudAuth.cancel",
  museCloudAuthImportCookies: "museCloudAuth.importCookies",
  geminiAuthComplete: "geminiAuth.complete",
  geminiAuthCancel: "geminiAuth.cancel",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverSummarizeToolActivity: "server.summarizeToolActivity",
  telegramChannelsStatus: "server.telegramChannelsStatus",
  telegramChannelsManage: "server.telegramChannelsManage",
  serverUpdateSettings: "server.updateSettings",
  assistantComputerControl: "assistant.computer.control",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerGetMcpToolsRpc = Rpc.make(WS_METHODS.serverGetMcpTools, {
  payload: Schema.Struct({
    check: Schema.optionalKey(Schema.Boolean),
    workspaceRoot: Schema.optionalKey(Schema.String),
  }),
  success: McpToolCatalog,
  error: Schema.Union([McpToolsError, EnvironmentAuthorizationError]),
});

export const WsServerGetExtensionsRpc = Rpc.make(WS_METHODS.serverGetExtensions, {
  payload: ExtensionLookup,
  success: ExtensionCatalog,
  error: Schema.Union([ExtensionError, EnvironmentAuthorizationError]),
});
export const WsServerManageExtensionRpc = Rpc.make(WS_METHODS.serverManageExtension, {
  payload: ExtensionActionInput,
  success: Schema.Struct({ message: Schema.String }),
  error: Schema.Union([ExtensionError, EnvironmentAuthorizationError]),
});
export const WsConversationPreviewRpc = Rpc.make(WS_METHODS.conversationPreview, {
  payload: ConversationPreviewInput,
  success: ConversationPreview,
  error: Schema.Union([ConversationTransferError, EnvironmentAuthorizationError]),
});
export const WsConversationImportRpc = Rpc.make(WS_METHODS.conversationImport, {
  payload: ConversationImportInput,
  success: Schema.Struct({ threadId: ThreadId }),
  error: Schema.Union([ConversationTransferError, EnvironmentAuthorizationError]),
});
export const WsConversationExportRpc = Rpc.make(WS_METHODS.conversationExport, {
  payload: ConversationExportInput,
  success: ConversationExport,
  error: Schema.Union([ConversationTransferError, EnvironmentAuthorizationError]),
});
export const WsDesignImageUploadRpc = Rpc.make(WS_METHODS.designImageUpload, {
  payload: DesignImageUploadInput,
  success: Schema.Struct({ attachmentId: Schema.String, caption: Schema.String }),
  error: Schema.Union([DesignImageUploadError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsGeminiAuthBeginRpc = Rpc.make(WS_METHODS.geminiAuthBegin, {
  payload: GeminiAuthBeginInput,
  success: GeminiAuthBeginResult,
  error: Schema.Union([GeminiAuthError, EnvironmentAuthorizationError]),
});

export const WsDeepSeekConnectRpc = Rpc.make(WS_METHODS.deepSeekConnect, {
  payload: DeepSeekConnectInput,
  success: DeepSeekConnectResult,
  error: Schema.Union([DeepSeekConnectionError, EnvironmentAuthorizationError]),
});

export const WsAntseedConnectRpc = Rpc.make(WS_METHODS.antseedConnect, {
  payload: AntseedConnectInput,
  success: AntseedConnectResult,
  error: Schema.Union([AntseedConnectionError, EnvironmentAuthorizationError]),
});

export const WsOpenCodeConnectRpc = Rpc.make(WS_METHODS.openCodeConnect, {
  payload: OpenCodeConnectInput,
  success: OpenCodeConnectResult,
  error: Schema.Union([OpenCodeConnectionError, EnvironmentAuthorizationError]),
});

export const WsOpenAiApiListModelsRpc = Rpc.make(WS_METHODS.openAiApiListModels, {
  payload: OpenAiApiListModelsInput,
  success: OpenAiApiListModelsResult,
  error: Schema.Union([OpenAiApiListModelsError, EnvironmentAuthorizationError]),
});

export const WsAiSearchListEmbeddingModelsRpc = Rpc.make(WS_METHODS.aiSearchListEmbeddingModels, {
  payload: AiSearchListEmbeddingModelsInput,
  success: AiSearchListEmbeddingModelsResult,
  error: Schema.Union([AiSearchListEmbeddingModelsError, EnvironmentAuthorizationError]),
});

export const WsProviderAccountLoginRpc = Rpc.make(WS_METHODS.providerAccountLogin, {
  payload: ProviderAccountLoginInput,
  success: ProviderAccountLoginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsGrokDeviceAuthBeginRpc = Rpc.make(WS_METHODS.grokDeviceAuthBegin, {
  payload: GrokDeviceAuthBeginInput,
  success: GrokDeviceAuthBeginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsGrokDeviceAuthWaitRpc = Rpc.make(WS_METHODS.grokDeviceAuthWait, {
  payload: GrokDeviceAuthWaitInput,
  success: ProviderAccountLoginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsGrokDeviceAuthCancelRpc = Rpc.make(WS_METHODS.grokDeviceAuthCancel, {
  payload: GrokDeviceAuthCancelInput,
  success: Schema.Struct({}),
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseAuthBeginRpc = Rpc.make(WS_METHODS.museAuthBegin, {
  payload: MuseAuthBeginInput,
  success: MuseAuthBeginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseAuthWaitRpc = Rpc.make(WS_METHODS.museAuthWait, {
  payload: MuseAuthWaitInput,
  success: ProviderAccountLoginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseAuthCancelRpc = Rpc.make(WS_METHODS.museAuthCancel, {
  payload: MuseAuthCancelInput,
  success: Schema.Struct({}),
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseCloudAuthBeginRpc = Rpc.make(WS_METHODS.museCloudAuthBegin, {
  payload: MuseCloudAuthBeginInput,
  success: MuseCloudAuthBeginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseCloudAuthWaitRpc = Rpc.make(WS_METHODS.museCloudAuthWait, {
  payload: MuseCloudAuthWaitInput,
  success: ProviderAccountLoginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseCloudAuthCancelRpc = Rpc.make(WS_METHODS.museCloudAuthCancel, {
  payload: MuseCloudAuthCancelInput,
  success: Schema.Struct({}),
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsMuseCloudAuthImportCookiesRpc = Rpc.make(WS_METHODS.museCloudAuthImportCookies, {
  payload: MuseCloudAuthCookieInput,
  success: ProviderAccountLoginResult,
  error: Schema.Union([ProviderAccountLoginError, EnvironmentAuthorizationError]),
});

export const WsGeminiAuthCompleteRpc = Rpc.make(WS_METHODS.geminiAuthComplete, {
  payload: GeminiAuthCompleteInput,
  success: GeminiAuthCompleteResult,
  error: Schema.Union([GeminiAuthError, EnvironmentAuthorizationError]),
});

export const WsGeminiAuthCancelRpc = Rpc.make(WS_METHODS.geminiAuthCancel, {
  payload: GeminiAuthCancelInput,
  success: Schema.Struct({}),
  error: Schema.Union([GeminiAuthError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerWithProgressRpc = Rpc.make(
  WS_METHODS.serverUpdateServerWithProgress,
  {
    payload: ServerSelfUpdateInput,
    success: ServerSelfUpdateProgressEvent,
    error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsServerSummarizeToolActivityRpc = Rpc.make(WS_METHODS.serverSummarizeToolActivity, {
  payload: ToolActivitySummaryInput,
  success: ToolActivitySummaryResult,
  error: EnvironmentAuthorizationError,
});

export const WsTelegramChannelsStatusRpc = Rpc.make(WS_METHODS.telegramChannelsStatus, {
  payload: TelegramChannelsStatusInput,
  success: TelegramChannelsStatusResult,
  error: Schema.Union([TelegramChannelsError, EnvironmentAuthorizationError]),
});

export const WsTelegramChannelsManageRpc = Rpc.make(WS_METHODS.telegramChannelsManage, {
  payload: TelegramChannelsManageInput,
  success: TelegramChannelsStatusResult,
  error: Schema.Union([TelegramChannelsError, EnvironmentAuthorizationError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export class AssistantComputerControlError extends Schema.TaggedErrorClass<AssistantComputerControlError>()(
  "AssistantComputerControlError",
  { message: Schema.String },
) {}

export const AssistantComputerStatus = Schema.Union([
  Schema.Struct({
    configured: Schema.Literal(false),
    timedOut: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    configured: Schema.Literal(true),
    image: Schema.String,
    network: Schema.Literals(["none", "bridge"]),
    status: Schema.String,
    timedOut: Schema.optionalKey(Schema.Boolean),
    kind: Schema.optionalKey(Schema.Literals(["container", "vm"])),
  }),
]);
export type AssistantComputerStatus = typeof AssistantComputerStatus.Type;

export const WsAssistantComputerControlRpc = Rpc.make(WS_METHODS.assistantComputerControl, {
  payload: Schema.Struct({
    threadId: ThreadId,
    command: Schema.Union([
      Schema.Struct({
        action: Schema.Literal("create"),
        image: Schema.String,
        network: Schema.Literals(["none", "bridge"]),
        kind: Schema.optionalKey(Schema.Literals(["container", "vm"])),
      }),
      Schema.Struct({ action: Schema.Literals(["status", "start", "stop", "remove"]) }),
      Schema.Struct({
        action: Schema.Literal("wait_ready"),
        timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 })),
      }),
    ]),
  }),
  success: AssistantComputerStatus,
  error: Schema.Union([AssistantComputerControlError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadT3FileRpc = Rpc.make(WS_METHODS.projectsReadT3File, {
  payload: ProjectReadT3FileInput,
  success: ProjectReadT3FileResult,
  error: Schema.Union([EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationCheckTurnReceiptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.checkTurnReceipt,
  {
    payload: OrchestrationRpcSchemas.checkTurnReceipt.input,
    success: OrchestrationRpcSchemas.checkTurnReceipt.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationRpcSchemas.getWorkflowScript.input,
    success: OrchestrationRpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

export const WsGetPdfRevisionStatusRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getPdfRevisionStatus, {
  payload: OrchestrationRpcSchemas.getPdfRevisionStatus.input,
  success: OrchestrationRpcSchemas.getPdfRevisionStatus.output,
  error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
});
export const WsStartPdfRevisionRpc = Rpc.make(ORCHESTRATION_WS_METHODS.startPdfRevision, {
  payload: OrchestrationRpcSchemas.startPdfRevision.input,
  success: OrchestrationRpcSchemas.startPdfRevision.output,
  error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
});
export const WsRetryPdfRevisionRpc = Rpc.make(ORCHESTRATION_WS_METHODS.retryPdfRevision, {
  payload: OrchestrationRpcSchemas.retryPdfRevision.input,
  success: OrchestrationRpcSchemas.retryPdfRevision.output,
  error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
});
export const WsReadPdfRevisionSourceRpc = Rpc.make(ORCHESTRATION_WS_METHODS.readPdfRevisionSource, {
  payload: OrchestrationRpcSchemas.readPdfRevisionSource.input,
  success: OrchestrationRpcSchemas.readPdfRevisionSource.output,
  error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationEditWorkspaceKnowledgeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.editWorkspaceKnowledge,
  {
    payload: OrchestrationRpcSchemas.editWorkspaceKnowledge.input,
    success: OrchestrationRpcSchemas.editWorkspaceKnowledge.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);
export const WsOrchestrationRestoreWorkspaceKnowledgeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.restoreWorkspaceKnowledge,
  {
    payload: OrchestrationRpcSchemas.restoreWorkspaceKnowledge.input,
    success: OrchestrationRpcSchemas.restoreWorkspaceKnowledge.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);
export const WsOrchestrationListWorkspaceKnowledgeRevisionsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceKnowledgeRevisions,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceKnowledgeRevisions.input,
    success: OrchestrationRpcSchemas.listWorkspaceKnowledgeRevisions.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);
export const WsOrchestrationGetWorkspaceKnowledgeRevisionRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeRevision,
  {
    payload: OrchestrationRpcSchemas.getWorkspaceKnowledgeRevision.input,
    success: OrchestrationRpcSchemas.getWorkspaceKnowledgeRevision.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkspaceKnowledgeDashboardRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard,
  {
    payload: OrchestrationRpcSchemas.getWorkspaceKnowledgeDashboard.input,
    success: OrchestrationRpcSchemas.getWorkspaceKnowledgeDashboard.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceKnowledgeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceKnowledge.input,
    success: OrchestrationRpcSchemas.listWorkspaceKnowledge.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkspaceWikiLinksRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkspaceWikiLinks,
  {
    payload: OrchestrationRpcSchemas.getWorkspaceWikiLinks.input,
    success: OrchestrationRpcSchemas.getWorkspaceWikiLinks.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetThreadTokenUsageRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadTokenUsage,
  {
    payload: OrchestrationRpcSchemas.getThreadTokenUsage.input,
    success: OrchestrationRpcSchemas.getThreadTokenUsage.output,
    error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSearchWorkspaceRagRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.searchWorkspaceRag,
  {
    payload: OrchestrationRpcSchemas.searchWorkspaceRag.input,
    success: OrchestrationRpcSchemas.searchWorkspaceRag.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationComposeWorkspacePromptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.composeWorkspacePrompt,
  {
    payload: OrchestrationRpcSchemas.composeWorkspacePrompt.input,
    success: OrchestrationRpcSchemas.composeWorkspacePrompt.output,
    error: Schema.Union([OrchestrationWorkspaceKnowledgeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceAgentRolesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceAgentRoles,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceAgentRoles.input,
    success: OrchestrationRpcSchemas.listWorkspaceAgentRoles.output,
    error: Schema.Union([OrchestrationWorkspaceAgentRolesError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceCollaborationRunsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceCollaborationRuns,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceCollaborationRuns.input,
    success: OrchestrationRpcSchemas.listWorkspaceCollaborationRuns.output,
    error: Schema.Union([OrchestrationWorkspaceCollaborationError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceSchedulesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceSchedules,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceSchedules.input,
    success: OrchestrationRpcSchemas.listWorkspaceSchedules.output,
    error: Schema.Union([OrchestrationWorkspaceScheduleError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkspaceRuntimeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkspaceRuntime,
  {
    payload: OrchestrationRpcSchemas.getWorkspaceRuntime.input,
    success: OrchestrationRpcSchemas.getWorkspaceRuntime.output,
    error: Schema.Union([OrchestrationWorkspaceRuntimeError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeWorkspaceRuntimeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeWorkspaceRuntime,
  {
    payload: OrchestrationRpcSchemas.subscribeWorkspaceRuntime.input,
    success: OrchestrationRpcSchemas.subscribeWorkspaceRuntime.output,
    error: Schema.Union([OrchestrationWorkspaceRuntimeError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsOrchestrationDiscoverWorkspaceProgramsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.discoverWorkspacePrograms,
  {
    payload: OrchestrationRpcSchemas.discoverWorkspacePrograms.input,
    success: OrchestrationRpcSchemas.discoverWorkspacePrograms.output,
    error: Schema.Union([OrchestrationWorkspaceProgramError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceProgramsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspacePrograms,
  {
    payload: OrchestrationRpcSchemas.listWorkspacePrograms.input,
    success: OrchestrationRpcSchemas.listWorkspacePrograms.output,
    error: Schema.Union([OrchestrationWorkspaceProgramError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceProgramRunsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceProgramRuns,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceProgramRuns.input,
    success: OrchestrationRpcSchemas.listWorkspaceProgramRuns.output,
    error: Schema.Union([OrchestrationWorkspaceProgramError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationListWorkspaceIncidentsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listWorkspaceIncidents,
  {
    payload: OrchestrationRpcSchemas.listWorkspaceIncidents.input,
    success: OrchestrationRpcSchemas.listWorkspaceIncidents.output,
    error: Schema.Union([OrchestrationWorkspaceProgramError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsOrchestrationCleanupWorkspaceWorktreeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.cleanupWorkspaceWorktree,
  {
    payload: OrchestrationRpcSchemas.cleanupWorkspaceWorktree.input,
    success: OrchestrationRpcSchemas.cleanupWorkspaceWorktree.output,
    error: Schema.Union([OrchestrationWorktreeCleanupError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetSharedLibraryStatusRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getSharedLibraryStatus,
  {
    payload: OrchestrationRpcSchemas.getSharedLibraryStatus.input,
    success: OrchestrationRpcSchemas.getSharedLibraryStatus.output,
    error: Schema.Union([OrchestrationSharedLibraryError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSyncSharedLibraryRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.syncSharedLibrary,
  {
    payload: OrchestrationRpcSchemas.syncSharedLibrary.input,
    success: OrchestrationRpcSchemas.syncSharedLibrary.output,
    error: Schema.Union([OrchestrationSharedLibraryError, EnvironmentAuthorizationError]),
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsMemoryForgetRpc = Rpc.make(WORKSPACE_MEMORY_WS_METHODS.forgetMessage, {
  payload: WorkspaceMemoryForgetInput,
  success: Schema.String,
  error: Schema.Union([WorkspaceMemoryError, EnvironmentAuthorizationError]),
});
export const WsMemoryRememberRpc = Rpc.make(WORKSPACE_MEMORY_WS_METHODS.remember, {
  payload: WorkspaceMemoryRememberInput,
  success: Schema.String,
  error: Schema.Union([WorkspaceMemoryError, EnvironmentAuthorizationError]),
});

export const WsDevelopmentGetRpc = Rpc.make(WORKSPACE_DEVELOPMENT_WS_METHODS.get, {
  payload: WorkspaceDevelopmentLookup,
  success: WorkspaceDevelopmentSnapshot,
  error: Schema.Union([WorkspaceDevelopmentError, EnvironmentAuthorizationError]),
});
export const WsDevelopmentSubscribeRpc = Rpc.make(WORKSPACE_DEVELOPMENT_WS_METHODS.subscribe, {
  payload: WorkspaceDevelopmentLookup,
  success: WorkspaceDevelopmentSnapshot,
  stream: true,
  error: Schema.Union([WorkspaceDevelopmentError, EnvironmentAuthorizationError]),
});
export const WsDevelopmentConfigureRpc = Rpc.make(WORKSPACE_DEVELOPMENT_WS_METHODS.configure, {
  payload: WorkspaceDevelopmentConfigure,
  success: WorkspaceDevelopmentState,
  error: Schema.Union([WorkspaceDevelopmentError, EnvironmentAuthorizationError]),
});
export const WsDevelopmentDirectInputRpc = Rpc.make(WORKSPACE_DEVELOPMENT_WS_METHODS.directInput, {
  payload: WorkspaceDevelopmentDirectInput,
  success: WorkspaceDevelopmentState,
  error: Schema.Union([WorkspaceDevelopmentError, EnvironmentAuthorizationError]),
});
export const WsDevelopmentReturnControlRpc = Rpc.make(
  WORKSPACE_DEVELOPMENT_WS_METHODS.returnControl,
  {
    payload: WorkspaceDevelopmentReturnControl,
    success: WorkspaceDevelopmentState,
    error: Schema.Union([WorkspaceDevelopmentError, EnvironmentAuthorizationError]),
  },
);
export const WsRpcGroup = RpcGroup.make(
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.getRun, {
    payload: WorkflowRunLookup,
    success: WorkspaceCollaborationRun,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.overview, {
    payload: WorkflowLookup,
    success: WorkflowOverview,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.skills, {
    payload: WorkflowLookup,
    success: WorkflowSkillCatalog,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.chatSkills, {
    payload: WorkflowChatSkillLookup,
    success: WorkflowChatSkillCatalog,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.save, {
    payload: WorkflowSave,
    success: WorkflowVersion,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.preview, {
    payload: WorkflowPreview,
    success: WorkflowPreviewResult,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.start, {
    payload: WorkflowStart,
    success: WorkspaceCollaborationRun,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_WORKFLOW_WS_METHODS.control, {
    payload: WorkflowControl,
    success: WorkspaceCollaborationRun,
    error: Schema.Union([WorkspaceWorkflowError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AGENT_CONTROL_WS_METHODS.attention, {
    payload: WorkspaceAttentionLookup,
    success: WorkspaceAttentionOverview,
    stream: true,
    error: Schema.Union([WorkspaceAgentControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AGENT_CONTROL_WS_METHODS.subscribe, {
    payload: WorkspaceAgentControlLookup,
    success: WorkspaceAgentControlOverview,
    stream: true,
    error: Schema.Union([WorkspaceAgentControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AGENT_CONTROL_WS_METHODS.overview, {
    payload: WorkspaceAgentControlLookup,
    success: WorkspaceAgentControlOverview,
    error: Schema.Union([WorkspaceAgentControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AGENT_CONTROL_WS_METHODS.action, {
    payload: WorkspaceAgentControlAction,
    success: WorkspaceAgentControlOverview,
    error: Schema.Union([WorkspaceAgentControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AGENT_CONTROL_WS_METHODS.evidence, {
    payload: WorkspaceAgentControlEvidenceInput,
    success: WorkspaceAgentControlEvidence,
    error: Schema.Union([WorkspaceAgentControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_TASK_INBOX_WS_METHODS.subscribe, {
    payload: WorkspaceTaskInboxLookup,
    success: WorkspaceTaskInboxOverview,
    stream: true,
    error: Schema.Union([WorkspaceTaskInboxError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_TASK_INBOX_WS_METHODS.overview, {
    payload: WorkspaceTaskInboxLookup,
    success: WorkspaceTaskInboxOverview,
    error: Schema.Union([WorkspaceTaskInboxError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_TASK_INBOX_WS_METHODS.get, {
    payload: WorkspaceTaskLookup,
    success: Schema.NullOr(WorkspaceInboxTask),
    error: Schema.Union([WorkspaceTaskInboxError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_TASK_INBOX_WS_METHODS.saveRecipe, {
    payload: WorkspaceTaskRecipeSave,
    success: WorkspaceTaskRecipe,
    error: Schema.Union([WorkspaceTaskInboxError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_TASK_INBOX_WS_METHODS.submit, {
    payload: WorkspaceTaskSubmit,
    success: WorkspaceInboxTask,
    error: Schema.Union([WorkspaceTaskInboxError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_TASK_INBOX_WS_METHODS.action, {
    payload: WorkspaceTaskAction,
    success: WorkspaceInboxTask,
    error: Schema.Union([WorkspaceTaskInboxError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_RESEARCH_WS_METHODS.status, {
    payload: WorkspaceResearchLookup,
    success: WorkspaceResearchStatus,
    error: Schema.Union([WorkspaceResearchError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_RESEARCH_WS_METHODS.run, {
    payload: WorkspaceResearchInput,
    success: WorkspaceResearchCall,
    error: Schema.Union([WorkspaceResearchError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_RESEARCH_WS_METHODS.configureKey, {
    payload: WorkspaceResearchKeyInput,
    success: Schema.Struct({ apiKeyReady: Schema.Boolean }),
    error: Schema.Union([WorkspaceResearchError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AUTOMATION_WS_METHODS.overview, {
    payload: WorkspaceAutomationLookup,
    success: WorkspaceAutomationOverview,
    error: Schema.Union([WorkspaceAutomationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_AUTOMATION_WS_METHODS.evidence, {
    payload: WorkspaceAutomationEvidenceInput,
    success: WorkspaceAutomationEvidence,
    error: Schema.Union([WorkspaceAutomationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WORKSPACE_DEVELOPMENT_WS_METHODS.goal, {
    payload: WorkspaceDevelopmentGoalInput,
    success: WorkspaceDevelopmentState,
    error: Schema.Union([WorkspaceDevelopmentError, EnvironmentAuthorizationError]),
  }),
  WsDevelopmentGetRpc,
  WsDevelopmentSubscribeRpc,
  WsDevelopmentConfigureRpc,
  WsDevelopmentDirectInputRpc,
  WsDevelopmentReturnControlRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerGetMcpToolsRpc,
  WsServerGetExtensionsRpc,
  WsServerManageExtensionRpc,
  WsConversationPreviewRpc,
  WsConversationImportRpc,
  WsConversationExportRpc,
  WsDesignImageUploadRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsGeminiAuthBeginRpc,
  WsDeepSeekConnectRpc,
  WsAntseedConnectRpc,
  WsOpenCodeConnectRpc,
  WsOpenAiApiListModelsRpc,
  WsAiSearchListEmbeddingModelsRpc,
  WsProviderAccountLoginRpc,
  WsGrokDeviceAuthBeginRpc,
  WsGrokDeviceAuthWaitRpc,
  WsGrokDeviceAuthCancelRpc,
  WsMuseAuthBeginRpc,
  WsMuseAuthWaitRpc,
  WsMuseAuthCancelRpc,
  WsMuseCloudAuthBeginRpc,
  WsMuseCloudAuthWaitRpc,
  WsMuseCloudAuthCancelRpc,
  WsMuseCloudAuthImportCookiesRpc,
  WsGeminiAuthCompleteRpc,
  WsGeminiAuthCancelRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerSummarizeToolActivityRpc,
  WsTelegramChannelsStatusRpc,
  WsTelegramChannelsManageRpc,
  WsServerUpdateSettingsRpc,
  WsAssistantComputerControlRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsReadT3FileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationCheckTurnReceiptRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetThreadTokenUsageRpc,
  WsOrchestrationEditWorkspaceKnowledgeRpc,
  WsOrchestrationRestoreWorkspaceKnowledgeRpc,
  WsGetPdfRevisionStatusRpc,
  WsStartPdfRevisionRpc,
  WsRetryPdfRevisionRpc,
  WsReadPdfRevisionSourceRpc,
  WsOrchestrationListWorkspaceKnowledgeRevisionsRpc,
  WsOrchestrationGetWorkspaceKnowledgeRevisionRpc,
  WsOrchestrationGetWorkspaceKnowledgeDashboardRpc,
  WsOrchestrationListWorkspaceKnowledgeRpc,
  WsOrchestrationGetWorkspaceWikiLinksRpc,
  WsMemoryForgetRpc,
  WsMemoryRememberRpc,
  WsOrchestrationSearchWorkspaceRagRpc,
  WsOrchestrationComposeWorkspacePromptRpc,
  WsOrchestrationListWorkspaceAgentRolesRpc,
  WsOrchestrationListWorkspaceCollaborationRunsRpc,
  WsOrchestrationListWorkspaceSchedulesRpc,
  WsOrchestrationGetWorkspaceRuntimeRpc,
  WsOrchestrationSubscribeWorkspaceRuntimeRpc,
  WsOrchestrationDiscoverWorkspaceProgramsRpc,
  WsOrchestrationListWorkspaceProgramsRpc,
  WsOrchestrationListWorkspaceProgramRunsRpc,
  WsOrchestrationListWorkspaceIncidentsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationCleanupWorkspaceWorktreeRpc,
  WsOrchestrationGetSharedLibraryStatusRpc,
  WsOrchestrationSyncSharedLibraryRpc,
  Rpc.make(COUNCIL_WS_METHODS.triage, {
    payload: CouncilTriageInput,
    success: CouncilTriageResult,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.startAutoSeat, {
    payload: CouncilStartAutoSeatInput,
    success: CouncilSessionSnapshot,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.getSession, {
    payload: CouncilGetSessionInput,
    success: CouncilSessionSnapshot,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.listThreadSessions, {
    payload: CouncilListThreadSessionsInput,
    success: CouncilListThreadSessionsResult,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.approveOverride, {
    payload: CouncilApproveOverrideInput,
    success: CouncilSessionSnapshot,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.executePinnedSpec, {
    payload: CouncilExecutePinnedSpecInput,
    success: CouncilExecutePinnedSpecResult,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.reverifyPinnedSpec, {
    payload: CouncilReverifyPinnedSpecInput,
    success: CouncilSessionSnapshot,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.abort, {
    payload: CouncilAbortInput,
    success: CouncilSessionSnapshot,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(COUNCIL_WS_METHODS.subscribe, {
    payload: CouncilSubscribeInput,
    success: CouncilStreamEvent,
    stream: true,
    error: Schema.Union([CouncilError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.getSnapshot, {
    payload: MissionGetSnapshotInput,
    success: MissionControlSnapshot,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.subscribe, {
    payload: MissionSubscribeInput,
    success: MissionControlStreamEvent,
    stream: true,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.createMission, {
    payload: MissionCreateInput,
    success: MissionRun,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.cancelMission, {
    payload: MissionCancelInput,
    success: MissionRun,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.deleteMission, {
    payload: MissionDeleteInput,
    success: Schema.Struct({ deleted: Schema.Boolean, missionId: Schema.String }),
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.decideApproval, {
    payload: MissionDecideApprovalInput,
    success: MissionControlSnapshot,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.upsertCrewRole, {
    payload: MissionCrewRoleUpsertInput,
    success: MissionCrewRole,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.deleteCrewRole, {
    payload: MissionCrewRoleDeleteInput,
    success: Schema.Struct({ deleted: Schema.Boolean, roleId: Schema.String }),
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.startSyncMeeting, {
    payload: MissionSyncMeetingInput,
    success: MissionControlSnapshot,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.startRoundtableMeeting, {
    payload: MissionRoundtableStartInput,
    success: MissionMeetingRecord,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.cancelMeeting, {
    payload: MissionMeetingActionInput,
    success: MissionMeetingRecord,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.deleteMeeting, {
    payload: MissionMeetingActionInput,
    success: Schema.Struct({ deleted: Schema.Boolean, meetingId: Schema.String }),
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.promoteMeetingToMission, {
    payload: MissionPromoteMeetingInput,
    success: MissionRun,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.setSynapsePruned, {
    payload: MissionSynapsePruneInput,
    success: Schema.Struct({ updated: Schema.Boolean }),
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.killSwitch, {
    payload: MissionKillSwitchInput,
    success: MissionControlSnapshot,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.generateDigestNow, {
    payload: MissionDigestNowInput,
    success: MissionReport,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.runHeartbeatCheck, {
    payload: MissionHeartbeatCheckInput,
    success: MissionHeartbeatCheckResult,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(MISSION_CONTROL_WS_METHODS.inspectArtifact, {
    payload: MissionInspectArtifactInput,
    success: MissionInspectArtifactResult,
    error: Schema.Union([MissionControlError, EnvironmentAuthorizationError]),
  }),
);
