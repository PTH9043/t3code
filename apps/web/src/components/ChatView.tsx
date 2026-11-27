import { isRecoverableUserInputRequestId, rollupBackgroundTasks } from "@t3tools/contracts";
import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  CommandId,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
} from "@t3tools/contracts";
import { connectionStatusTitle, usesLocalBackend } from "@t3tools/client-runtime/connection";
import {
  effectiveSettled,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";
import { executionProfileTask } from "@t3tools/shared/executionProfile";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { truncate } from "@t3tools/shared/String";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { useDiffPanelStore } from "../diffPanelStore";
import {
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  deriveBackgroundWatchStatus,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveTurnPlans,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { getAnchoredTurnMetrics, type TimelineScrollMode } from "./chat/timelineScrollAnchoring";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  resolvePendingUserInputAdvance,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { hasUnseenCompletion } from "./Sidebar.logic";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { RightPanelTabs } from "./RightPanelTabs";
import { AgentsPanel } from "./AgentsPanel";
import { deriveThreadTimelineWork } from "./chat/threadTimelineWork";
import { ActivitySummaryProvider } from "./chat/ActivitySummaryProvider";
import { ThreadTurnViewer } from "./chat/ThreadTurnViewer";
import { RoomModelSettings } from "./chat/RoomModelSettings";
import { ResponseStylePill } from "./chat/ResponseStyleIndicators";
import { useBackgroundWatchNotice } from "./chat/useBackgroundWatchNotice";
import { DraftDiscardButton } from "./chat/DraftDiscardButton";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import {
  AlarmClockIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  GitBranchIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  UsersIcon,
  WifiOffIcon,
} from "lucide-react";
import { cn, randomHex, randomUUID } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { isolateVoiceContext } from "../assistantVoiceFlow";
import { useBrowserHistoryStore } from "~/browserHistoryStore";
import { resolveSelectableProvider } from "../providerModels";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useResponseStyleUiProfile } from "../hooks/useResponseStyleUiProfile";
import { useNowMinute } from "../hooks/useNowMinute";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { preventRepeatedTerminalCloseShortcut } from "../lib/terminalCloseShortcut";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  derivePhysicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import { useWorkspaceTabStore } from "../workspaceTabStore";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  selectDraftIdByThreadRef,
  restoreDraftFolderProjectId,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  activeMeetingConversationKey,
  disarmMeetingComposer,
  meetingSetupFromConfig,
  readMeetingComposerConfig,
} from "../meetingComposerStore";
import { selectIndependentMeetingCoordinator } from "./chat/chatWorkflow";
import { formatComposerRequest, readComposerRequestMode } from "../askFirstStore";
import { TaskConditionsDialog } from "./chat/TaskConditionsDialog";
import { createTaskConditionsDraft, type TaskConditionsDraft } from "../taskConditions";
import {
  type ApprovedTaskConditions,
  renderApprovedTaskConditions,
  resolveEffectiveGlobalAssistant,
} from "@t3tools/contracts";
import { orchestrationEnvironment } from "../state/orchestration";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
  formatElementContextLabel,
} from "../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";
import { environmentCatalog } from "../connection/catalog";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  useProject,
  useProjects,
  useThreadShells,
  useThread,
  useThreadRefs,
  useThreadShell,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle, type RoomModelPicker } from "./chat/ChatComposer";
import { ComposerFileDropZone } from "./chat/ComposerFileDropZone";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { resolveTimelineIsAtEnd } from "./chat/MessagesTimeline.logic";
import { ChatHeader, ChatViewerToggle, ChatWorkerEngineToggle } from "./chat/ChatHeader";
import { WorkerEnginePanel } from "../t3x/workerEngine/WorkerEnginePanel";
import { useWorkerEngineSummary } from "../t3x/workerEngine/useWorkerEngineSummary";
import { ThreadCouncilDock } from "./council/ThreadCouncilDock";
import { ThreadMissionDock } from "./chat/ThreadMissionDock";
import { BackgroundActivityLivePanel } from "./chat/BackgroundActivityLivePanel";
import { ThreadCharacter } from "./chat/ThreadCharacter";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { UpgradeRoomOfflineWorkCard } from "./chat/UpgradeRoomOfflineWorkCard";
import { UpgradeRoomProgressCard } from "./chat/UpgradeRoomProgress";
import { selectUpgradeRoomProgress } from "@t3tools/client-runtime/state/thread-tool-activity";
import { resolveThreadPr } from "./ThreadStatusIndicators";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  interruptedWorkLabel,
  orchestraBlocksByMessage,
} from "@t3tools/client-runtime/state/presentation";
import { ThreadSyncStatusPill } from "./chat/ThreadSyncStatusPill";
import { useChatViewShortcuts } from "./chat/useChatViewShortcuts";
import {
  useComposerBannerItems,
  useSystemComposerBannerItems,
} from "./chat/useChatComposerBanners";
import {
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildDraftThreadCreateBootstrap,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  collectUserMessageBlobPreviewUrls,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
  suppressEnvironmentReconnectBanner,
  hasRecentAccountAutoSwitch,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  resolveVisibleThreadError,
  revokeBlobPreviewUrl,
  prepareOrchestraMessage,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  shouldWaitForActiveModelBeforeSending,
  startNewThreadForProject,
  waitForStartedServerThread,
} from "./ChatView.logic";
import type { ThreadSyncPhase } from "../threadSync";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import {
  DEFAULT_DEVELOPMENT_INPUT_TARGET,
  type DevelopmentInputTarget,
} from "./chat/WorkspaceDevelopmentPanel";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ServerUpdateAction, ServerUpdateProgress } from "./ServerUpdateAction";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
} from "../versionSkew";
import { useAssetUrls } from "../assets/assetUrls";
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
  type TerminalLaunchContext,
} from "./chat/ChatTerminalPanel";
import {
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  EMPTY_ACTIVITIES,
  EMPTY_PROVIDERS,
  EMPTY_PROVIDER_SKILLS,
  EMPTY_PENDING_USER_INPUT_ANSWERS,
  uploadMeetingQuestionImages,
  selectWorkspaceOperationsRevision,
  useDraftHeroLayoutTransition,
  hasComposerDraftContent,
  EMPTY_PENDING_FILE_SURFACE_IDS,
  shouldTypeToFocusComposer,
  formatOutgoingPrompt,
  assistantModelMatches,
  SCRIPT_TERMINAL_COLS,
  SCRIPT_TERMINAL_ROWS,
  useLocalDispatchState,
  chatActionErrorMessage,
  type EnvironmentUnavailableState,
  type LocalThreadErrorEntry,
} from "./chat/chatViewHelpers";
export { hasComposerDraftContent } from "./chat/chatViewHelpers";

const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("./DiffPanel"));
const loadFilePreviewPanel = () => import("./files/FilePreviewPanel");
const FilePreviewPanel = lazy(loadFilePreviewPanel);

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      desktopAssistantCharacter?: import("@t3tools/contracts").ThreadCharacter;
      desktopAssistantModelSelection?: ModelSelection;
      desktopAssistantVoiceRequest?: { id: string; text: string };
      onDesktopAssistantVoiceHandled?: (
        id: string,
        outcome: "sent" | "blocked" | "unknown",
      ) => void;
      hideCharacter?: boolean;
      threadSyncPhase?: ThreadSyncPhase | null;
      routeKind: "server";
      dedicatedRoom?: {
        emptyThread: Thread;
        modelSelection: ModelSelection | null;
        picker: RoomModelPicker;
        sendDisabledReason: string | null;
      };
      draftId?: never;
      /**
       * False when this view lives in a background workspace tab. Kept
       * mounted for instant switching, but window-level listeners must stand
       * down — ten hidden ChatViews all answering one shortcut would be chaos.
       */
      isForeground?: boolean;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      desktopAssistantCharacter?: import("@t3tools/contracts").ThreadCharacter;
      desktopAssistantModelSelection?: ModelSelection;
      desktopAssistantVoiceRequest?: { id: string; text: string };
      onDesktopAssistantVoiceHandled?: (
        id: string,
        outcome: "sent" | "blocked" | "unknown",
      ) => void;
      hideCharacter?: boolean;
      threadSyncPhase?: never;
      routeKind: "draft";
      draftId: DraftId;
      isForeground?: boolean;
    };

function ChatViewContent(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
    desktopAssistantCharacter,
    desktopAssistantModelSelection,
    hideCharacter = false,
    isForeground = true,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const threadSyncPhase = routeKind === "server" ? (props.threadSyncPhase ?? null) : null;
  const dedicatedRoom = props.routeKind === "server" ? props.dedicatedRoom : undefined;
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const createMissionInThreadCmd = useAtomCommand(orchestrationEnvironment.createMission, {
    label: "대화창 자율 미션 실행",
    reportFailure: false,
  });
  const requestMeetingRun = useAtomCommand(orchestrationEnvironment.startWorkflow, {
    reportFailure: false,
  });
  const interjectMeetingRun = useAtomCommand(
    projectEnvironment.interjectWorkspaceCollaborationRun,
    {
      reportFailure: false,
    },
  );
  const answerMeetingRun = useAtomCommand(projectEnvironment.answerWorkspaceCollaborationRun, {
    reportFailure: false,
  });
  const approveMonitoringPlan = useAtomCommand(projectEnvironment.approveWorkspaceMonitoringPlan, {
    reportFailure: false,
  });
  const cancelMeetingRun = useAtomCommand(projectEnvironment.cancelWorkspaceCollaborationRun, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const localDraftId = useComposerDraftStore(
    (store) => draftId ?? selectDraftIdByThreadRef(store, routeThreadRef),
  );
  const draftThread = useComposerDraftStore((store) =>
    localDraftId ? store.getDraftSession(localDraftId) : null,
  );
  const routeServerThreadShell = useThreadShell(routeKind === "server" ? routeThreadRef : null);
  const serverThread = useThread(routeThreadRef, {
    waitForShell: draftThread !== null || !!dedicatedRoom,
  });
  const threadDetailLoading =
    threadSyncPhase === "loading" || (!!dedicatedRoom && !!routeServerThreadShell && !serverThread);
  const loadingServerThread = useMemo(
    () =>
      threadDetailLoading && routeServerThreadShell
        ? buildLoadingThreadFromShell(routeServerThreadShell)
        : null,
    [routeServerThreadShell, threadDetailLoading],
  );
  const activeServerThread = serverThread ?? loadingServerThread;
  // Pagination window state for the routed server thread: drives the
  // "load earlier turns" header when the loaded window has older history.
  const routeThreadState = useEnvironmentThread(
    routeKind === "server" ? routeThreadRef.environmentId : null,
    routeKind === "server" && (!dedicatedRoom || routeServerThreadShell)
      ? routeThreadRef.threadId
      : null,
  );
  const loadEarlierTurns = useMemo(() => {
    if (routeKind !== "server" || !threadHasOlderTurns(routeThreadState)) {
      return null;
    }
    return {
      loading: routeThreadState.page._tag === "Some" && routeThreadState.page.value.loadingOlder,
      onLoadEarlier: () => {
        requestOlderThreadTurns(routeThreadRef.environmentId, routeThreadRef.threadId);
      },
    };
  }, [routeKind, routeThreadRef, routeThreadState]);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const settings = useEnvironmentSettings(environmentId);
  // New-thread defaults live in the primary environment's settings.json (the
  // settings UI never writes to remote environments), so read them from the
  // primary server rather than the thread's environment.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const hasLocalDraftContent = useComposerDraftStore((store) =>
    draftId ? hasComposerDraftContent(store.getComposerDraft(draftId)) : false,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftElementContexts = useComposerDraftStore(
    (store) => store.setElementContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [pendingTaskConditions, setPendingTaskConditions] = useState<{
    contextKey: string;
    threadId: string;
    draft: TaskConditionsDraft;
    workOnlyReason?: string;
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    };
  } | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  /**
   * The session error text the person closed, per thread. Keyed by the message
   * so a later, different failure still surfaces — see
   * {@link resolveVisibleThreadError}.
   */
  const [dismissedSessionErrorsByThreadKey, setDismissedSessionErrorsByThreadKey] = useState<
    Record<string, string>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const pendingQuestionImageUrlsRef = useRef(
    new Map<string, { threadId: ThreadId; urls: Set<string> }>(),
  );
  useEffect(
    () => () => {
      for (const entry of pendingQuestionImageUrlsRef.current.values()) {
        for (const url of entry.urls) URL.revokeObjectURL(url);
      }
      pendingQuestionImageUrlsRef.current.clear();
    },
    [],
  );
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const [draftWorkflowStarts, setDraftWorkflowStarts] = useState(0);
  const trackDraftWorkflowStart = useCallback((starting: boolean) => {
    setDraftWorkflowStarts((count) => (starting ? count + 1 : count - 1));
  }, []);
  const sendInFlightSinceRef = useRef(0);
  const beginSendInFlight = useCallback(() => {
    sendInFlightRef.current = true;
    sendInFlightSinceRef.current = Date.now();
  }, []);
  /**
   * A hung command (a server restart mid-await) must not brick the composer
   * forever: past the watchdog window the stale lock releases itself. While
   * genuinely locked, callers must SAY so — a silently dropped message reads
   * as "the app ignored me".
   */
  const isSendLocked = useCallback(() => {
    if (!sendInFlightRef.current) return false;
    if (Date.now() - sendInFlightSinceRef.current > 15_000) {
      sendInFlightRef.current = false;
      return false;
    }
    return true;
  }, []);
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(composerOverlayElement);
    return () => observer.disconnect();
  }, [composerOverlayElement]);

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = useMemo(() => serverThreadRefs.map(scopedThreadKey), [serverThreadRefs]);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = activeServerThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!activeServerThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [activeServerThread, draftId, localDraftErrorsByDraftId, routeThreadKey]);
  const globalPersonaDefaultModel = useEnvironmentSettings(environmentId, (envSettings) => {
    const effective = resolveEffectiveGlobalAssistant(envSettings);
    return effective?.enabled ? (effective.defaultModelSelection ?? null) : null;
  });
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            globalPersonaDefaultModel ??
              fallbackDraftProject?.defaultModelSelection ??
              NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, globalPersonaDefaultModel, threadId],
  );
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? dedicatedRoom?.emptyThread ?? localDraftThread;
  const sessionError = activeServerThread?.session?.lastError ?? null;
  const threadError = resolveVisibleThreadError({
    isServerThread,
    localDraftError,
    localServerError,
    sessionError,
    dismissedSessionError: dismissedSessionErrorsByThreadKey[routeThreadKey] ?? null,
  });
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  // Plan mode is legacy (Settings → Beta). With the flag off the effective
  // mode is forced to "default" — even for threads with a stored plan mode —
  // so nobody is trapped in plan mode while its toggle is hidden. The next
  // send persists "default" back to the thread.
  const interactionMode = settings.planModeEnabled
    ? (composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE)
    : DEFAULT_INTERACTION_MODE;
  const workflowInteractionMode =
    composerInteractionMode ?? activeThread?.interactionMode ?? interactionMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadEnvironmentId = activeThread?.environmentId ?? null;
  // One profile for the header pill, timeline, turn viewer and composer.
  const responseStyleProfile = useResponseStyleUiProfile(
    activeThread?.environmentId ?? environmentId,
    activeThreadId,
    isLocalDraftThread ? localDraftId : null,
  );
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = useMemo(() => {
    if (activeThreadId === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  }, [activeThreadId, activeThreadKnownSessionsRaw]);
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  );
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const activeTerminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [activeThreadKnownSessions]);
  const activeThreadRef = useMemo(
    () =>
      activeThreadEnvironmentId && activeThreadId
        ? scopeThreadRef(activeThreadEnvironmentId, activeThreadId)
        : null,
    [activeThreadEnvironmentId, activeThreadId],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelKind = activeRightPanelSurface?.kind;
  const diffOpen = activeRightPanelKind === "diff";
  const viewerOpen = activeRightPanelKind === "agents";
  const workersOpen = activeRightPanelKind === "workers";
  const teamAddModelRef = useRef<HTMLSelectElement>(null);
  const modelSettingsId = useId();
  const [modelSettingsPanel, setModelSettingsPanel] = useState<{
    threadKey: typeof activeThreadKey;
    open: boolean;
  } | null>(null);
  const panelStorageKey = activeThreadKey && "t3.room-model-settings:" + activeThreadKey;
  const restoredPanelOpen = useMemo(() => {
    try {
      return panelStorageKey !== null && window.sessionStorage.getItem(panelStorageKey) === "open";
    } catch {
      return false;
    }
  }, [panelStorageKey]);
  const currentPanel =
    modelSettingsPanel?.threadKey === activeThreadKey ? modelSettingsPanel : null;
  const modelSettingsOpen = currentPanel?.open ?? restoredPanelOpen;
  const hasOpenedModelSettings = currentPanel !== null || restoredPanelOpen;
  const toggleModelSettings = () => {
    const open = !modelSettingsOpen;
    setModelSettingsPanel({ threadKey: activeThreadKey, open });
    if (!panelStorageKey) return;
    try {
      if (open) window.sessionStorage.setItem(panelStorageKey, "open");
      else window.sessionStorage.removeItem(panelStorageKey);
    } catch {
      // The panel remains usable when this tab cannot persist its state.
    }
  };
  const [composerSelection, setComposerSelection] = useState<{
    threadKey: string | null;
    selection: ModelSelection | null;
  } | null>(null);
  const handleComposerModelChange = useCallback(
    (selection: ModelSelection | null) => {
      setComposerSelection((current) =>
        current?.threadKey === activeThreadKey &&
        JSON.stringify(current.selection) === JSON.stringify(selection)
          ? current
          : { threadKey: activeThreadKey, selection },
      );
    },
    [activeThreadKey],
  );
  const composerModelSelection =
    composerSelection?.threadKey === activeThreadKey ? composerSelection.selection : null;
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeFileSurface =
    activeRightPanelSurface?.kind === "file" ? activeRightPanelSurface : null;
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  );
  const allocatableActiveTerminalIds = useMemo(
    () => [...new Set([...activeKnownTerminalIds, ...panelTerminalIds])],
    [activeKnownTerminalIds, panelTerminalIds],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && isPreviewSupportedInRuntime();
  const rightPanelOpen = rightPanelState.isOpen;
  const canMaximizeRightPanel = rightPanelOpen && !shouldUseRightPanelSheet;
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUseRightPanelSheet;

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewState.sessions));
  }, [activePreviewState.sessions, activeThreadRef]);

  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const miniTabStillExists = Boolean(activePreviewState.sessions[activePreviewMiniPlayer.tabId]);
    const sameTabOpenInPanel =
      previewPanelOpen &&
      activeRightPanelSurface?.kind === "preview" &&
      activeRightPanelSurface.resourceId === activePreviewMiniPlayer.tabId;
    if (!miniTabStillExists || sameTabOpenInPanel) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
  ]);

  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  // Reading a finished thread clears the sidebar's Done badge. The visit is
  // stamped at the turn's completion time — not now/updatedAt — so it clears
  // exactly the completion the user is looking at: a wake or completion that
  // lands later still gets its signal (markThreadVisited never moves the
  // timestamp backwards).
  useEffect(() => {
    const completedAt = serverThread?.latestTurn?.completedAt;
    if (!serverThread?.id || !completedAt) return;
    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      completedAt,
    );
  }, [
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.latestTurn?.completedAt,
  ]);
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalUiState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalUiState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useProject(activeProjectRef);
  const developmentQuery = useEnvironmentQuery(
    activeProject
      ? orchestrationEnvironment.workspaceDevelopment({
          environmentId,
          input: { projectId: activeProject.id },
        })
      : null,
  );
  const developmentState = developmentQuery.data?.state ?? null;
  // Historical workspace state remains readable, but it never redirects a normal chat.
  const developmentEnabled = false;
  const [developmentTarget, setDevelopmentTarget] = useState<DevelopmentInputTarget>(
    DEFAULT_DEVELOPMENT_INPUT_TARGET,
  );
  const sendDevelopmentInput = useAtomCommand(orchestrationEnvironment.directDevelopmentInput);
  useEffect(() => {
    setDevelopmentTarget(DEFAULT_DEVELOPMENT_INPUT_TARGET);
  }, [activeThread?.id, environmentId, developmentEnabled]);
  const developmentComposerContext = useMemo(
    () =>
      isServerThread &&
      activeThread &&
      activeProject &&
      !activeThread.worktreePath &&
      developmentQuery.data !== null
        ? {
            environmentId,
            projectId: activeProject.id,
            conversationId: activeThread.id,
            mainModel: activeThread.modelSelection,
            runtimeMode,
            interactionMode,
            state: developmentState,
            target: developmentTarget,
            onTargetChange: setDevelopmentTarget,
          }
        : null,
    [
      isServerThread,
      activeThread?.id,
      activeThread?.worktreePath,
      activeThread?.modelSelection,
      runtimeMode,
      interactionMode,
      activeProject?.id,
      developmentQuery.data,
      developmentState,
      developmentTarget,
      environmentId,
    ],
  );
  // Whether this conversation hosts a live meeting must be known on EVERY
  // send, not just armed ones: a plain turn started into a meeting thread
  // replaces the seat's turn mid-flight and kills the run ("Collaboration
  // turn was replaced before its result was collected").
  // Loaded for every folder surface (drafts included): the meeting-mode-off
  // cancellation must reach the folder's live runs no matter which pane the
  // switch was flipped from.
  const meetingRunsQuery = useEnvironmentQuery(
    activeProject
      ? orchestrationEnvironment.workspaceCollaborationRuns({
          environmentId,
          input: { projectId: activeProject.id },
        })
      : null,
  );
  // The runs query only fetches on mount, but the send path needs it CURRENT:
  // a meeting that started after mount is otherwise invisible here, so the
  // stop banner never shows and a message meant as an interjection convenes a
  // whole new meeting. The live workspace-runtime subscription carries a
  // revision for exactly this. Only the revision is selected: the subscription
  // is shared with the sidebar and control center, and its full snapshot turns
  // over on every thread state change — this view must not re-render for that.
  const meetingOperationsRevision = useEnvironmentQuerySelector(
    activeProject
      ? orchestrationEnvironment.workspaceRuntime({
          environmentId,
          input: { projectId: activeProject.id },
        })
      : null,
    selectWorkspaceOperationsRevision,
  );
  const lastMeetingOperationsRevisionRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (meetingOperationsRevision === null) return;
    if (lastMeetingOperationsRevisionRef.current === undefined) {
      lastMeetingOperationsRevisionRef.current = meetingOperationsRevision;
      return;
    }
    if (lastMeetingOperationsRevisionRef.current === meetingOperationsRevision) return;
    lastMeetingOperationsRevisionRef.current = meetingOperationsRevision;
    meetingRunsQuery.refresh();
  }, [meetingRunsQuery.refresh, meetingOperationsRevision]);
  // Every meeting run that owns THIS conversation, running first. They drive
  // the stop banner above the composer and claim the send path further below.
  const liveMeetingRuns = useMemo(() => {
    if (!isServerThread || !activeThread) return [];
    const statusRank = { running: 0, queued: 1, "cancel-requested": 2 };
    return (meetingRunsQuery.data?.runs ?? [])
      .filter(
        (run) =>
          run.meeting?.threadId === activeThread.id &&
          (run.status === "queued" ||
            run.status === "running" ||
            run.status === "cancel-requested"),
      )
      .sort(
        (left, right) =>
          (statusRank[left.status as keyof typeof statusRank] ?? 3) -
          (statusRank[right.status as keyof typeof statusRank] ?? 3),
      );
  }, [activeThread, isServerThread, meetingRunsQuery.data]);
  const liveMeetingRun = liveMeetingRuns[0];
  // The live run's pending question, surfaced as a composer card so a person
  // never misses that the run is parked waiting on them. Clicking an option
  // answers it directly; a free-typed message still answers via the send path.
  const orchestraPendingQuestion = liveMeetingRun?.meeting?.pendingQuestion ?? null;
  const [answeringOrchestraQuestion, setAnsweringOrchestraQuestion] = useState(false);
  const handleAnswerOrchestraQuestion = useCallback(
    async (answer: string) => {
      const run = liveMeetingRun;
      const question = run?.meeting?.pendingQuestion;
      const prepared = prepareOrchestraMessage(answer);
      if (prepared.kind === "too-long") {
        toastManager.add({ title: "답변은 8,000자 이하로 입력하세요.", type: "warning" });
        return;
      }
      const trimmed = prepared.text;
      if (run === undefined || !question || trimmed.length === 0) return;
      const attachments = [...composerImagesRef.current];
      if (attachments.some((item) => item.type !== "image")) {
        toastManager.add({ type: "warning", title: "질문에는 이미지 파일을 첨부하세요." });
        return;
      }
      setAnsweringOrchestraQuestion(true);
      try {
        const images = await uploadMeetingQuestionImages(attachments);
        const answered = await answerMeetingRun({
          environmentId,
          input: {
            runId: run.id,
            projectId: run.projectId,
            question: question.question,
            questionRef: { nodeId: question.nodeId, askedAt: question.askedAt },
            answer: trimmed,
            ...(images.length ? { images } : {}),
          },
        });
        if (answered._tag === "Failure") {
          if (!isAtomCommandInterrupted(answered)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "오케스트라 질문에 답변을 보내지 못했습니다",
                description: "연결 상태를 확인하고 다시 시도하세요.",
              }),
            );
          }
          return;
        }
        for (const image of attachments) removeComposerDraftImage(composerDraftTarget, image.id);
        meetingRunsQuery.refresh();
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "오케스트라 질문에 답변했습니다",
            description: "답변을 반영해 오케스트라가 이어집니다.",
          }),
        );
      } catch {
        toastManager.add({ type: "error", title: "질문에 첨부한 이미지를 읽지 못했습니다." });
      } finally {
        setAnsweringOrchestraQuestion(false);
      }
    },
    [
      answerMeetingRun,
      composerDraftTarget,
      environmentId,
      liveMeetingRun,
      meetingRunsQuery.refresh,
      removeComposerDraftImage,
    ],
  );
  // Stopping stops EVERYTHING live in this conversation — a running meeting
  // and anything queued behind it — in one act.
  const handleStopMeetingRun = useCallback(async () => {
    const targets = liveMeetingRuns.filter((run) => run.status !== "cancel-requested");
    if (targets.length === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title:
            liveMeetingRuns.length > 0
              ? "이미 중지 요청이 전달됐습니다"
              : "중지할 오케스트라가 없습니다",
          description:
            liveMeetingRuns.length > 0
              ? "진행 중인 발언이 끊기는 대로 오케스트라가 종료됩니다."
              : "이 대화에서 진행 중인 오케스트라가 없어 아무것도 보내지 않았습니다.",
        }),
      );
      return;
    }
    let failed = false;
    for (const run of targets) {
      const cancelled = await cancelMeetingRun({
        environmentId,
        input: { projectId: run.projectId, runId: run.id },
      });
      if (cancelled._tag === "Failure" && !isAtomCommandInterrupted(cancelled)) failed = true;
    }
    toastManager.add(
      failed
        ? stackedThreadToast({
            type: "error",
            title: "오케스트라를 중지하지 못했습니다",
            description: "연결 상태를 확인하고 다시 시도하세요.",
          })
        : stackedThreadToast({
            type: "success",
            title:
              targets.length > 1
                ? `오케스트라 ${targets.length}건을 중지합니다`
                : "오케스트라를 중지합니다",
            description: "진행 중인 발언을 끊고 실행을 취소합니다.",
          }),
    );
  }, [cancelMeetingRun, environmentId, liveMeetingRuns]);
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  }, [activeProjectRef, handleNewThread]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProject?.scripts),
    [activeProject?.scripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  useEffect(() => {
    const shell = activeEnvironmentShell.data;
    if (
      !localDraftId ||
      !isLocalDraftThread ||
      activeProject ||
      shell?.status !== "live" ||
      shell.snapshot._tag !== "Some"
    )
      return;
    const projects = shell.snapshot.value.projects.map(({ id, workspaceRoot }) => ({
      environmentId,
      id,
      workspaceRoot,
    }));
    restoreDraftFolderProjectId(localDraftId, projects, useWorkspaceTabStore.getState());
  }, [localDraftId, isLocalDraftThread, activeProject, activeEnvironmentShell.data, environmentId]);
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  useEffect(() => {
    if (!clientSettingsHydrated || !activeThreadRef || !activeProject) return;
    // Reuse the sidebar's grouping so history follows the project rows the user
    // sees. Deriving the key from the active project alone would miss the
    // identity a duplicate row borrows from its siblings.
    const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects: allProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
    useBrowserHistoryStore
      .getState()
      .registerThreadProject(
        activeThreadRef,
        logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(activeProject)) ??
          deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings),
      );
  }, [
    activeProject,
    activeThreadRef,
    allProjects,
    clientSettingsHydrated,
    primaryEnvironmentId,
    projectGroupingSettings,
  ]);
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  // An automatic account switch restarts the provider session, which resets the
  // transport and flips the environment into `reconnecting`. That blip is a
  // normal failover, not a lost connection — suppress the warning while the
  // switch is settling so the banner does not cry wolf on every failover.
  const recentAccountAutoSwitch = useMemo(
    () => hasRecentAccountAutoSwitch(activeThread?.activities, Date.now()),
    [activeThread?.activities],
  );
  const localReconnect =
    activeReconnectingEnvironmentId !== null &&
    activeEnvironment !== null &&
    usesLocalBackend(activeEnvironment.entry.target);
  useEffect(() => {
    setReconnectWarningGraceElapsedEnvironmentId(null);
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(
      () => setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
      localReconnect,
    );
  }, [activeReconnectingEnvironmentId, localReconnect]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "실행 환경에 다시 연결하지 못했습니다",
            description: "연결 상태를 확인한 뒤 다시 시도하세요.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const label = environmentById.get(p.environmentId)?.label ?? p.environmentId;
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [activeProject, allProjects, projectGroupingSettings, primaryEnvironmentId, environmentById]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("이 PR에 사용할 활성 프로젝트가 없습니다.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} 서버`
      : "서버";
  const serverUpdateEnvironmentId = activeThread?.environmentId ?? null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const systemComposerBannerItems = useSystemComposerBannerItems({
    activeEnvironmentUnavailableState,
    reconnectWarningGraceElapsed,
    recentAccountAutoSwitch,
    localReconnect,
    handleReconnectActiveEnvironment,
    navigate,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    serverUpdateState,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  });
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  );
  const selectedProvider: ProviderDriverKind = unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const orchestraBlocks = useMemo(
    () => orchestraBlocksByMessage(threadActivities),
    [threadActivities],
  );
  const activeWorkTurnId =
    activeThread?.session?.status === "running" ? activeThread.session.activeTurnId : null;
  const upgradeRoomProgress = useMemo(
    () =>
      selectUpgradeRoomProgress(
        activeThread?.id ?? "",
        activeWorkTurnId,
        activeThread?.session?.updatedAt ?? "",
        threadActivities,
      ),
    [activeThread?.id, activeThread?.session?.updatedAt, activeWorkTurnId, threadActivities],
  );
  const workLogEntries = useMemo(
    () =>
      deriveThreadTimelineWork(
        threadActivities,
        activeLatestTurn,
        activeThread?.checkpoints,
        activeWorkTurnId,
      ),
    [threadActivities, activeLatestTurn, activeThread?.checkpoints, activeWorkTurnId],
  );
  const turnPlans = useMemo(() => deriveTurnPlans(threadActivities), [threadActivities]);
  // Native subagent fold: memoized by activity-list identity, shared by the
  // Agents surface, live strip, and workflow cards. v2Projection is null
  // until orchestration-v2 lands (source precedence lives in the derive).
  // sessionLive derives interruption for agents orphaned by session death.
  const agentSessionLive = phase !== "disconnected";
  const agentPanelModel = useMemo(
    () =>
      deriveAgentPanelModel({
        agents: foldSubagentActivities(threadActivities, { sessionLive: agentSessionLive }),
      }),
    [agentSessionLive, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  useEffect(() => {
    if (!activeThreadId) return;
    const resolved = new Set<string>();
    for (const activity of threadActivities) {
      if (
        activity.kind !== "user-input.resolved" ||
        !activity.payload ||
        typeof activity.payload !== "object"
      )
        continue;
      const requestId = (activity.payload as Record<string, unknown>).requestId;
      if (typeof requestId !== "string") continue;
      if (pendingUserInputs.some((request) => request.requestId === requestId)) continue;
      const entry = pendingQuestionImageUrlsRef.current.get(requestId);
      if (!entry || entry.threadId !== activeThreadId) continue;
      for (const url of entry.urls) URL.revokeObjectURL(url);
      pendingQuestionImageUrlsRef.current.delete(requestId);
      resolved.add(requestId);
    }
    if (!resolved.size) return;
    setPendingUserInputAnswersByRequestId((existing) => {
      const next = { ...existing };
      for (const requestId of resolved) {
        const answers = next[requestId];
        if (!answers) continue;
        next[requestId] = Object.fromEntries(
          Object.entries(answers).map(([questionId, draft]) => [
            questionId,
            { ...draft, images: [] },
          ]),
        );
      }
      return next;
    });
  }, [activeThreadId, pendingUserInputAnswersByRequestId, pendingUserInputs, threadActivities]);
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  // Current step for the in-chat working row: only for the running turn's own
  // plan (deriveActivePlanState falls back to older turns' plans, which must
  // not label fresh work). Falls back to the first pending step so an
  // all-pending freshly written plan labels the row, matching the chip and
  // the server's planProgress.
  const workingStepLabel = useMemo(() => {
    if (!activePlan || activePlan.turnId !== (activeLatestTurn?.turnId ?? null)) {
      return null;
    }
    return (
      activePlan.steps.find((step) => step.status === "inProgress")?.step ??
      activePlan.steps.find((step) => step.status === "pending")?.step ??
      null
    );
  }, [activeLatestTurn?.turnId, activePlan]);
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages ?? []) {
      for (const attachment of message.attachments ?? []) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    return serverMessages.map((message) => {
      if (!message.attachments || message.attachments.length === 0) {
        return message;
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment) => {
          const previewUrl = serverAttachmentUrlById.get(attachment.id);
          return previewUrl ? { ...attachment, previewUrl } : attachment;
        }),
      };
    });
  }, [serverAttachmentUrlById, serverMessages]);
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`${messageId} 서버 미리보기를 불러오지 못했습니다.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [attachmentPreviewHandoffByMessageId, displayServerMessages, optimisticUserMessages]);
  const windowedProposedPlans = useMemo(() => {
    const plans = activeThread?.proposedPlans ?? [];
    if (plans.length === 0 || loadEarlierTurns === null || timelineMessages.length === 0) {
      return plans;
    }
    const earliestLoadedMessageAt = timelineMessages[0]?.createdAt ?? null;
    if (earliestLoadedMessageAt === null) {
      return plans;
    }
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    return plans.filter(
      (plan) =>
        plan.createdAt >= earliestLoadedMessageAt ||
        (latestTurnId !== null && plan.turnId === latestTurnId),
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, loadEarlierTurns, timelineMessages]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, windowedProposedPlans, workLogEntries, turnPlans),
    [timelineMessages, turnPlans, windowedProposedPlans, workLogEntries],
  );
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState =
    isLocalDraftThread && timelineEntries.length === 0 && !isWorking && !draftHeroDockRequested;
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null;
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeThread?.session?.providerInstanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const chatProjectSkillsQuery = useEnvironmentQuery(
    activeProject
      ? orchestrationEnvironment.chatProjectSkills({
          environmentId: activeProject.environmentId,
          input: {
            projectId: activeProject.id,
            ...(isServerThread && activeThread ? { threadId: activeThread.id } : {}),
          },
        })
      : null,
  );
  const timelineSkills = useMemo(() => {
    const byName = new Map<string, ServerProvider["skills"][number]>();
    for (const provider of providerStatuses) {
      for (const skill of provider.skills) {
        if (!skill.enabled || skill.scope === "system") continue;
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    for (const skill of activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS) {
      if (skill.enabled) byName.set(skill.name, skill);
    }
    const catalog = chatProjectSkillsQuery.data;
    const projectSkills =
      selectedProvider === "claudeAgent"
        ? catalog?.claudeAgent
        : selectedProvider === "gemini"
          ? catalog?.gemini
          : selectedProvider === "codex"
            ? catalog?.codex
            : catalog?.grok;
    for (const skill of projectSkills ?? []) {
      if (skill.enabled) byName.set(skill.name, skill);
    }
    return byName.size > 0 ? Array.from(byName.values()) : EMPTY_PROVIDER_SKILLS;
  }, [
    activeProviderStatus?.skills,
    chatProjectSkillsQuery.data,
    providerStatuses,
    selectedProvider,
  ]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(threadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const showComposerContextStrip = shouldShowComposerContextStrip({
    hasActiveProject: activeProject !== null,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
  });
  const initialDiffPanelGitScope =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? "unstaged" : "branch";
  const diffPanelGitStatusResolutionKey = gitStatusQuery.data ? "resolved" : "pending";
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "stopped")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  );

  const dismissThreadError = useCallback(() => {
    setThreadError(activeThreadId, null);
    // The local entry alone is not enough: the session keeps its `lastError`
    // until the next turn, so the banner must be told which text to stay quiet
    // about.
    if (sessionError !== null) {
      setDismissedSessionErrorsByThreadKey((existing) =>
        existing[routeThreadKey] === sessionError
          ? existing
          : { ...existing, [routeThreadKey]: sessionError },
      );
    }
  }, [activeThreadId, routeThreadKey, sessionError, setThreadError]);

  // A dismissal covers one occurrence. Once the session drops the error, forget
  // it so the same text can raise the banner again if it comes back.
  useEffect(() => {
    if (sessionError !== null) return;
    setDismissedSessionErrorsByThreadKey((existing) => {
      if (existing[routeThreadKey] === undefined) return existing;
      const next = { ...existing };
      delete next[routeThreadKey];
      return next;
    });
  }, [routeThreadKey, sessionError]);

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (nextOpen && terminalUiState.terminalIds.length === 0) {
      if (!activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(allocatableActiveTerminalIds);
      storeEnsureTerminal(activeThreadRef, terminalId, { open: true });
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
      return;
    }
    setTerminalOpen(nextOpen);
  }, [
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    allocatableActiveTerminalIds,
    environmentId,
    gitCwd,
    openTerminal,
    setTerminalOpen,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!activeThreadRef || hasReachedSplitLimit || !activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(allocatableActiveTerminalIds);
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadRef, terminalId);
      } else {
        storeSplitTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeThreadId,
      allocatableActiveTerminalIds,
      activeThreadRef,
      openTerminal,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = nextTerminalId(allocatableActiveTerminalIds);
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeThreadId,
    allocatableActiveTerminalIds,
    activeThreadRef,
    openTerminal,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(allocatableActiveTerminalIds)
        : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput });
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          console.error(error);
          setThreadError(activeThreadId, `스크립트 "${script.name}"을 실행하지 못했습니다.`);
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        console.error(error);
        setThreadError(activeThreadId, `스크립트 "${script.name}"을 실행하지 못했습니다.`);
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      activeKnownTerminalIds,
      allocatableActiveTerminalIds,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [environmentId, updateProject, upsertKeybinding],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript = buildProjectScript(nextId, input);
      const nextScripts = [
        ...activeProject.scripts.map((script) => ({
          ...script,
          ...(input.runOnWorktreeCreate && script.runOnWorktreeCreate
            ? { runOnWorktreeCreate: false }
            : {}),
          ...(input.runOnWorktreeValidate && script.runOnWorktreeValidate
            ? { runOnWorktreeValidate: false }
            : {}),
          ...(input.runOnWorktreeCleanup && script.runOnWorktreeCleanup
            ? { runOnWorktreeCleanup: false }
            : {}),
        })),
        nextScript,
      ];

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("스크립트를 찾지 못했습니다.")));
      }

      const updatedScript = buildProjectScript(existingScript.id, input);
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : {
              ...script,
              ...(input.runOnWorktreeCreate && script.runOnWorktreeCreate
                ? { runOnWorktreeCreate: false }
                : {}),
              ...(input.runOnWorktreeValidate && script.runOnWorktreeValidate
                ? { runOnWorktreeValidate: false }
                : {}),
              ...(input.runOnWorktreeCleanup && script.runOnWorktreeCleanup
                ? { runOnWorktreeCleanup: false }
                : {}),
            },
      );

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `작업 "${deletedName ?? "이름 없음"}"을 삭제했습니다`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "작업을 삭제하지 못했습니다",
            description: "잠시 후 다시 시도하세요.",
          }),
        );
      }
      return result;
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const createBrowserSurface = useCallback(() => {
    if (!activeThreadRef) return;
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview });
  }, [activeThreadRef, openPreview]);
  const addDiffSurface = useCallback(() => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  }, [activeThreadRef, isGitRepo, isServerThread, onDiffPanelOpen]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    void loadFilePreviewPanel();
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const addAgentsSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "agents");
  }, [activeThreadRef]);
  const addWorkersSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "workers");
  }, [activeThreadRef]);
  const toggleViewer = useCallback(() => {
    if (!activeThreadRef) return;
    if (viewerOpen) setMaximizedRightPanelThreadKey(null);
    useRightPanelStore.getState().toggle(activeThreadRef, "agents");
  }, [activeThreadRef, viewerOpen]);
  const toggleWorkers = useCallback(() => {
    if (!activeThreadRef) return;
    if (workersOpen) setMaximizedRightPanelThreadKey(null);
    useRightPanelStore.getState().toggle(activeThreadRef, "workers");
  }, [activeThreadRef, workersOpen]);
  const workerEngineSummary = useWorkerEngineSummary({
    enabled: isForeground && isServerThread && activeThreadRef !== null,
    environmentId: activeThreadRef?.environmentId ?? null,
    threadId: activeThreadRef?.threadId ?? null,
  });
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      void loadFilePreviewPanel();
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
    },
    [activeProject, activeThreadRef],
  );
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewState.activeTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeThreadRef]);
  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) return;
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    const terminalId = nextTerminalId(allocatableActiveTerminalIds);
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    allocatableActiveTerminalIds,
    gitCwd,
    openTerminal,
  ]);
  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !activeThreadRef ||
        !activeThreadId ||
        !activeProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId(allocatableActiveTerminalIds);
      const cwd = gitCwd ?? activeProject.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      allocatableActiveTerminalIds,
      gitCwd,
      openTerminal,
    ],
  );
  const splitPanelTerminalVertical = useCallback(() => {
    splitPanelTerminal("vertical");
  }, [splitPanelTerminal]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, closeTerminalMutation, storeCloseTerminal],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    },
    [activeThreadRef, diffOpen, onDiffPanelOpen],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePreviewPanel, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      storeCloseTerminal,
    ],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces([surface]);
      useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef);
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "경로를 복사하지 못했습니다",
          description: "클립보드 기능을 사용할 수 없습니다.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "경로를 복사했습니다",
          description: relativePath,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "경로를 복사하지 못했습니다",
            description: "클립보드 권한을 확인한 뒤 다시 시도하세요.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      branch?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // State mirror of the follow mode refs. LegendList's maintainScrollAtEnd
  // re-pins on its own (independent of the refs), so the timeline needs a
  // render-visible flag to switch it off once the user scrolls away.
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  const isForegroundRef = useRef(isForeground);
  isForegroundRef.current = isForeground;
  const wasForegroundRef = useRef(isForeground);
  const [foregroundRevealNonce, setForegroundRevealNonce] = useState(0);
  const autoPrefetchedOlderPageByThreadRef = useRef<Set<string>>(new Set());
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  // Manual navigation stops live-follow without removing anchored end space.
  // Collapsing that space during a gesture clamps the viewport back to the end.
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    setTimelineLiveFollowEnabled(false);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
  }, []);
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);
  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) {
        return null;
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [composerOverlayHeight],
  );
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || state.data.length === 0) {
        return false;
      }

      const lastRowIndex = state.data.length - 1;
      const lastRowTop = state.positionAtIndex(lastRowIndex);
      const lastRowHeight = state.sizeAtIndex(lastRowIndex);
      if (
        typeof lastRowTop !== "number" ||
        typeof lastRowHeight !== "number" ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      ) {
        return false;
      }

      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight);
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - composerOverlayHeight - CHAT_LIST_ANCHOR_OFFSET,
      );
      return realContentBottom > visibleScrollLength;
    },
    [composerOverlayHeight],
  );
  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback((animated = false) => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor((current) =>
      current.messageId === null ? current : { ...current, messageId: null },
    );
    requestAnimationFrame(() => {
      void legendListRef.current?.scrollToEnd?.({ animated });
    });
  }, []);
  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollNode = legendListRef.current?.getScrollableNode();
        if (!scrollNode) {
          // The list may not have mounted on the first frame after a thread
          // switch — without a retry the opt-out listeners never attach and
          // live-follow becomes impossible to escape for the whole thread.
          if (remainingAttempts > 0) {
            attach(remainingAttempts - 1);
          }
          return;
        }
        const handleManualNavigation = () => {
          cancelTimelineLiveFollowForUserNavigationRef.current();
        };
        // The gestures below must only break follow when they can actually
        // move the viewport away from the live edge. Follow now gates
        // LegendList's maintainScrollAtEnd, so a spurious break while pinned
        // at the end produces no scroll event, never re-arms, and streaming
        // silently stops following. Underflowing content can't scroll at all,
        // so nothing there should break follow.
        const contentScrollsUp = () => timelineRealContentOverflowsViewport();
        // The follow re-arm band, not the strict flag: streaming growth makes
        // isAtEnd flicker false for a frame before the follow scroll catches
        // up, and a gesture landing in that window while still pinned would
        // otherwise break follow with no scroll event left to re-arm it.
        const viewportIsAwayFromEnd = () =>
          resolveTimelineIsAtEnd(legendListRef.current?.getState(), composerOverlayHeight) ===
          false;
        // Only an upward wheel is a navigation intent; wheeling down while
        // following either does nothing (at the end) or moves toward it.
        const handleWheel = (event: WheelEvent) => {
          if (event.deltaY < 0 && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // Touch direction isn't observable here (touchmove fires on any
        // finger motion, scrolling or not), so break only once the drag has
        // actually carried the viewport out of the end band — an upward flick
        // gets there within its first few events and later touchmoves break.
        const handleTouchMove = () => {
          if (viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Scrollbar drags produce no wheel/touch events; they are the only
        // pointerdowns whose target is the scroll node itself rather than a
        // message row. Content clicks break follow only away from the end
        // (reading or selecting up there must hold position); clicking near
        // the live edge keeps following.
        const handlePointerDown = (event: PointerEvent) => {
          if (event.target === scrollNode) {
            if (contentScrollsUp()) {
              handleManualNavigation();
            }
            return;
          }
          if (viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Keyboard scrolling (PageUp/Home/ArrowUp) bypasses wheel and
        // pointer events entirely; without this the timeline yanks back to
        // the end on the next stream chunk.
        const handleKeyDown = (event: KeyboardEvent) => {
          switch (event.key) {
            case "PageUp":
            case "Home":
            case "ArrowUp":
              if (contentScrollsUp()) {
                handleManualNavigation();
              }
              break;
            default:
              break;
          }
        };
        scrollNode.addEventListener("wheel", handleWheel, {
          passive: true,
        });
        scrollNode.addEventListener("touchmove", handleTouchMove, {
          passive: true,
        });
        scrollNode.addEventListener("pointerdown", handlePointerDown, {
          passive: true,
        });
        scrollNode.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          scrollNode.removeEventListener("wheel", handleWheel);
          scrollNode.removeEventListener("touchmove", handleTouchMove);
          scrollNode.removeEventListener("pointerdown", handlePointerDown);
          scrollNode.removeEventListener("keydown", handleKeyDown);
        };
      });
    };
    attach(12);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      removeListeners?.();
    };
  }, [activeThread?.id, composerOverlayHeight, timelineRealContentOverflowsViewport]);

  const onTimelineAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    // Anchored-end space can be remeasured when the turn completes. Once the
    // user has scrolled away (or returned to ordinary end-following), that
    // remeasurement must not restart the send-time anchor positioning.
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }
    if (pendingTimelineAnchorRef.current === messageId) {
      pendingTimelineAnchorRef.current = null;
    }
    activeTimelineAnchorIndexRef.current = anchorIndex;
    if (positionedTimelineAnchorRef.current === messageId) {
      return;
    }
    positionedTimelineAnchorRef.current = messageId;
    settledTimelineAnchorRef.current = null;
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) {
            positionAnchor(remainingAttempts - 1);
          }
          return;
        }
        void list
          .scrollToIndex({
            index: anchorIndex,
            animated: true,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          })
          .then(() => {
            if (positionedTimelineAnchorRef.current !== messageId) {
              return;
            }
            settledTimelineAnchorRef.current = messageId;
          });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  }, []);

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (!isForegroundRef.current && !isAtEnd) {
      return;
    }
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  // Anchored end space intentionally disables LegendList's normal end-follow so
  // the sent message can stay near the top. T3 only owns streaming adjustments
  // during that mode; LegendList owns ordinary end-follow everywhere else.
  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
      return;
    }
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
          return;
        }
        if (pendingTimelineAnchorRef.current !== null) {
          return;
        }
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        ) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          return;
        }

        const metrics = getActiveTimelineTurnMetrics(list);
        if (!metrics || metrics.scrollDeltaToRevealEnd <= 1) {
          return;
        }

        const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd;
        void list.scrollToOffset({ offset: nextOffset, animated: false });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [activeThread?.id, timelineEntries, getActiveTimelineTurnMetrics]);

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id]);

  // Returning from a hidden workspace tab (<Activity mode="hidden">) must
  // immediately reveal the latest settled result at the bottom rather than
  // stranding the viewport in collapsed/stale historical scroll offsets.
  useLayoutEffect(() => {
    const wasForeground = wasForegroundRef.current;
    wasForegroundRef.current = isForeground;
    if (wasForeground || !isForeground || !activeThread?.id) {
      return;
    }
    setForegroundRevealNonce((nonce) => nonce + 1);
    scrollToEnd(false);
    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      void legendListRef.current?.scrollToEnd?.({ animated: false });
      secondFrame = requestAnimationFrame(() => {
        void legendListRef.current?.scrollToEnd?.({ animated: false });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [activeThread?.id, isForeground, scrollToEnd]);

  // Once a turn finishes, release any send-time top-anchor reservation so
  // completed work naturally pins at the bottom with maintainScrollAtEnd.
  useEffect(() => {
    if (isWorking || !latestTurnSettled || timelineAnchorMessageId === null) {
      return;
    }
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      setTimelineAnchor((current) =>
        current.messageId === null ? current : { ...current, messageId: null },
      );
      return;
    }
    scrollToEnd(false);
  }, [isWorking, latestTurnSettled, scrollToEnd, timelineAnchorMessageId]);

  // After the initial tail slice paints and settles at the bottom, silently
  // prefetch one older page in the background so recent history is already
  // attached above without delaying first paint or moving the viewport.
  useEffect(() => {
    if (
      !isForeground ||
      routeKind !== "server" ||
      !serverThread ||
      serverThread.messages.length === 0 ||
      loadEarlierTurns === null ||
      loadEarlierTurns.loading
    ) {
      return;
    }
    if (autoPrefetchedOlderPageByThreadRef.current.has(routeThreadKey)) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (!isForegroundRef.current) {
        return;
      }
      autoPrefetchedOlderPageByThreadRef.current.add(routeThreadKey);
      requestOlderThreadTurns(routeThreadRef.environmentId, routeThreadRef.threadId);
    }, 320);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    isForeground,
    loadEarlierTurns,
    routeKind,
    routeThreadKey,
    routeThreadRef.environmentId,
    routeThreadRef.threadId,
    serverThread,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        primaryServerSettings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  // Settled state of the open thread, resolved exactly like the sidebar
  // partition (same shell, same capability gate, same PR auto-settle input)
  // so the banner and the sidebar row never disagree.
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const activeThreadPr = resolveThreadPr({
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const nowMinute = useNowMinute();
  const snoozeNow = new Date().toISOString();
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: snoozeNow });
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  void snoozeWakeTick;
  const activeThreadWokeAt =
    activeThreadShell !== null && supportsSnooze
      ? threadWokeAt(activeThreadShell, { now: snoozeNow })
      : null;
  useEffect(() => {
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const acknowledgeActiveThreadWoke = useCallback(() => {
    if (activeThreadRef === null || activeThreadWokeAt === null) return;
    markThreadVisited(scopedThreadKey(activeThreadRef), activeThreadWokeAt);
  }, [activeThreadRef, activeThreadWokeAt, markThreadVisited]);
  // Mirror of the sidebar's Woke pill for the open thread: same visit
  // comparison, same merged/closed-PR suppression (finished work needs no
  // wake-up call). Drives the dismissible composer banner below.
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadWokeVisible = useMemo(() => {
    if (activeThreadWokeAt === null) return false;
    if (activeThreadPr?.state === "merged" || activeThreadPr?.state === "closed") return false;
    const wokeAtMs = Date.parse(activeThreadWokeAt);
    if (Number.isNaN(wokeAtMs)) return false;
    // Having the thread open counts as a visit at completedAt (the effect
    // above stamps it); folding that floor in here keeps a completion-
    // triggered wake from flashing a banner for one frame before the stamp
    // lands. An unparseable stored visit counts as never-visited: corrupt
    // local data must not eat the wake signal.
    const storedVisitMs = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    const completedAtMs = activeLatestTurn?.completedAt
      ? Date.parse(activeLatestTurn.completedAt)
      : NaN;
    const lastVisitedMs = Math.max(
      Number.isNaN(storedVisitMs) ? -Infinity : storedVisitMs,
      Number.isNaN(completedAtMs) ? -Infinity : completedAtMs,
    );
    return lastVisitedMs < wokeAtMs;
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    activeThreadPr?.state,
    activeThreadWokeAt,
  ]);
  const activeThreadSettled = useMemo(() => {
    if (activeThreadShell === null || !supportsSettlement) return false;
    return effectiveSettled(activeThreadShell, {
      now: `${nowMinute}:00.000Z`,
      autoSettleAfterDays,
      changeRequestState: activeThreadPr?.state ?? null,
    });
  }, [
    activeThreadPr?.state,
    activeThreadShell,
    autoSettleAfterDays,
    nowMinute,
    supportsSettlement,
  ]);
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    try {
      const result = await unsettleThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "대화의 완료 상태를 해제하지 못했습니다",
            description: "잠시 후 다시 시도하세요.",
          }),
        );
      }
    } finally {
      setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsettleThreadMutation]);
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    try {
      const result = await unsnoozeThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "대화를 다시 활성화하지 못했습니다",
            description: "잠시 후 다시 시도하세요.",
          }),
        );
      }
    } finally {
      setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsnoozeThreadMutation]);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.elementContexts.length > 0 ||
        draft.previewAnnotations.length > 0 ||
        draft.reviewComments.length > 0),
    );
  });
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "체크아웃을 전환하지 못했습니다",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "체크아웃은 전환했지만 대화를 업데이트하지 못했습니다",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ]);
  // Background work (subagent fleets, workflow runs, watch loops) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. Stop routes through the
  // stop-everything interrupt: it kills every live background task before
  // interrupting, and works by session, so no active turn is needed.
  // "What is the seat doing while I'm not looking": watch loops, the next
  // self-wakeup, last check-in, and whether a restart cut them off. Read from
  // the activity log, so it is there after a reload and when the liveness
  // registry (in-memory on the server) is empty. Re-evaluated once a minute so
  // "next wake" expires on time.
  const [watchClockMs, setWatchClockMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setWatchClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const backgroundWatch = useMemo(
    () => deriveBackgroundWatchStatus(threadActivities, watchClockMs),
    [threadActivities, watchClockMs],
  );
  const { visible: showWatchInterruption, dismiss: dismissWatchInterruption } =
    useBackgroundWatchNotice(
      routeThreadKey,
      backgroundWatch.interrupted,
      serverConfig?.settings.backgroundWatchNoticeSeconds ?? 0,
    );
  const hasConfirmedMonitor = backgroundWatch.monitors.some((task) => task.isMonitor);
  const backgroundWatchDescription = useMemo(() => {
    const clock = (iso: string) =>
      new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    const parts: string[] = [];
    if (backgroundWatch.monitors.length > 0) {
      const titles = backgroundWatch.monitors
        .map((monitor) => monitor.title)
        .filter((title): title is string => title !== null)
        .slice(0, 3)
        .join(" · ");
      const label = backgroundWatch.monitors.every((task) => task.isMonitor)
        ? "감시"
        : "백그라운드 작업";
      parts.push(`${label} ${backgroundWatch.monitors.length}개${titles ? `: ${titles}` : ""}`);
    }
    if (backgroundWatch.lastCheckedAt !== null) {
      parts.push(`마지막 확인 ${clock(backgroundWatch.lastCheckedAt)}`);
    }
    if (backgroundWatch.nextWakeAt !== null) {
      parts.push(
        `다음 자동 확인 ${clock(backgroundWatch.nextWakeAt)}${backgroundWatch.nextWakeReason ? ` — ${backgroundWatch.nextWakeReason}` : ""}`,
      );
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [backgroundWatch]);
  // While a turn runs, the composer's own stop button covers agent work, but
  // watch loops are still live underneath and the person must keep seeing
  // them — dropping the banner read as "monitoring got released".
  const shellBackgroundLiveness = activeThread
    ? (activeThreadShell?.backgroundLiveness ?? null)
    : null;
  // Mid-turn, only a standing watch loop counts: the seat's own short
  // background shells register as monitors for a second or two each and
  // would flicker the banner on every command.
  const hasStandingWatch = backgroundWatch.monitors.some(
    (monitor) => watchClockMs - Date.parse(monitor.startedAt) >= 60_000,
  );
  const activeBackgroundLiveness = !isWorking
    ? shellBackgroundLiveness
    : shellBackgroundLiveness === "monitoring" && hasStandingWatch
      ? "monitoring"
      : null;
  const [isStoppingBackgroundWork, setIsStoppingBackgroundWork] = useState(false);
  useEffect(() => {
    // "Stopping..." holds until the liveness clears; the interrupt command
    // returning only means the request was accepted.
    if (activeBackgroundLiveness === null) {
      setIsStoppingBackgroundWork(false);
    }
  }, [activeBackgroundLiveness]);
  useEffect(() => {
    // Per-thread state: switching threads while A's stop is pending must not
    // disable B's Stop button (review finding).
    setIsStoppingBackgroundWork(false);
  }, [activeThreadId]);
  const handleStopBackgroundWork = useCallback(async () => {
    if (!activeThread) return;
    setIsStoppingBackgroundWork(true);
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread, { stopBackground: true }),
    });
    if (result._tag === "Failure") {
      // Every failure clears the pending state — an interrupted command
      // never reached the server, so liveness would hold "Stopping..."
      // forever. Only real failures toast.
      setIsStoppingBackgroundWork(false);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.error(error);
        setThreadError(activeThread.id, "백그라운드 작업을 중지하지 못했습니다.");
      }
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError]);
  const activeBackgroundTasks = activeThreadShell?.backgroundTasks ?? [];
  const activeBackgroundMonitorTitles = useMemo(
    () =>
      backgroundWatch.monitors
        .map((monitor) => monitor.title)
        .filter((title): title is string => title !== null && title.trim().length > 0),
    [backgroundWatch.monitors],
  );
  const latestBackgroundActivityLabel = useMemo(() => {
    const latest = threadActivities.at(-1);
    const summary = latest?.summary?.trim() ?? "";
    return summary.length > 0 ? summary : null;
  }, [threadActivities]);
  const showBackgroundLivePanel =
    Boolean(activeThread) &&
    (activeBackgroundTasks.some((task) => task.state !== "COMPLETED") ||
      activeBackgroundLiveness !== null ||
      activeBackgroundMonitorTitles.length > 0);
  const backgroundLivenessBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    // When BackgroundActivityLivePanel is shown directly above the composer, avoid
    // rendering a duplicate 1-line liveness banner inside ComposerBannerStack.
    if (showBackgroundLivePanel || activeBackgroundLiveness === null || !activeThread) {
      return null;
    }
    const working = activeBackgroundLiveness === "working";
    const liveCount = agentPanelModel.liveCount;
    const rollup = rollupBackgroundTasks(activeBackgroundTasks);
    const providerSummary = rollup.byProvider
      .map((entry) => `${entry.label}(${entry.count})`)
      .join(" · ");
    const multiModelTitle =
      rollup.totalActive > 0 && providerSummary
        ? `활성 BG ${rollup.totalActive}건: ${providerSummary}${
            rollup.stalledCount > 0 ? ` · 지연 ${rollup.stalledCount}건` : ""
          }`
        : null;
    return {
      id: `background-liveness:${activeThread.id}`,
      variant: "default",
      icon: (
        <span
          className={cn(
            "size-1.5 rounded-full",
            rollup.failedCount > 0
              ? "bg-destructive"
              : rollup.stalledCount > 0
                ? "bg-warning"
                : "bg-foreground",
            working && rollup.stalledCount === 0 && "animate-status-pulse",
          )}
          aria-hidden="true"
        />
      ),
      title:
        multiModelTitle ??
        (working
          ? liveCount > 0
            ? `에이전트 ${liveCount}개가 백그라운드에서 작업 중입니다`
            : "백그라운드 작업 실행 중"
          : !hasConfirmedMonitor
            ? "백그라운드 작업 실행 중"
            : isWorking
              ? "답변하는 동안에도 백그라운드 감시는 계속됩니다"
              : "백그라운드에서 모니터링 중"),
      ...(backgroundWatchDescription === null ? {} : { description: backgroundWatchDescription }),
      // The stop affordance belongs to the composer while a turn runs.
      ...(isWorking
        ? {}
        : {
            actions: (
              <Button
                size="xs"
                variant="outline"
                disabled={isStoppingBackgroundWork}
                onClick={() => void handleStopBackgroundWork()}
              >
                {isStoppingBackgroundWork ? "중지 중..." : "중지"}
              </Button>
            ),
          }),
    };
  }, [
    activeBackgroundLiveness,
    activeBackgroundTasks,
    activeThread,
    agentPanelModel.liveCount,
    backgroundWatchDescription,
    handleStopBackgroundWork,
    hasConfirmedMonitor,
    isStoppingBackgroundWork,
    isWorking,
    showBackgroundLivePanel,
  ]);
  // Without live work there is still something to say when a wake is
  // scheduled, or when a restart silently killed the watch the person was
  // relying on — that second case is the one they could not otherwise see.
  const backgroundWatchBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (
      !activeThread ||
      isWorking ||
      showBackgroundLivePanel ||
      backgroundLivenessBannerItem !== null
    )
      return null;
    const clock = (iso: string) =>
      new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    if (showWatchInterruption && backgroundWatch.interrupted !== null) {
      const { eventId, at } = backgroundWatch.interrupted;
      const what = interruptedWorkLabel(backgroundWatch.interrupted);
      return {
        id: `background-watch-interrupted:${routeThreadKey}:${eventId}`,
        variant: "warning",
        icon: <EyeIcon />,
        title: `${clock(at)} 서버 재시작으로 중단된 항목 · ${what}`,
        dismissLabel: "중단 알림 닫기",
        dismissImmediately: true,
        onDismiss: dismissWatchInterruption,
      };
    }
    if (backgroundWatch.nextWakeAt !== null) {
      return {
        id: `background-watch:${activeThread.id}`,
        variant: "default",
        icon: <AlarmClockIcon />,
        title: `다음 자동 확인 ${clock(backgroundWatch.nextWakeAt)} 예정`,
        ...(backgroundWatchDescription === null ? {} : { description: backgroundWatchDescription }),
      };
    }
    return null;
  }, [
    activeThread,
    backgroundLivenessBannerItem,
    backgroundWatch,
    backgroundWatchDescription,
    dismissWatchInterruption,
    routeThreadKey,
    showWatchInterruption,
    isWorking,
  ]);
  // A woken thread announces itself in the open view, not just the sidebar
  // pill. Dismissing marks the wake as seen (same acknowledgment as the
  // pill); sending a message clears it as a side effect of the send path.
  const wokeThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadWokeVisible) {
      return null;
    }
    return {
      id: `thread-woke:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: <AlarmClockIcon />,
      title: "이 대화의 다시 알림 시간이 되었습니다",
      description: "표시를 지우려면 닫고, 계속하려면 메시지를 보내세요.",
      dismissLabel: "다시 알림 닫기",
      onDismiss: acknowledgeActiveThreadWoke,
    };
  }, [acknowledgeActiveThreadWoke, activeThread?.id, activeThreadWokeVisible]);
  // The 감시 AI speaks up wherever the person is: when the active project's
  // monitoring thread has a report or a question they have not seen, a line
  // appears above this composer too (the sidebar eye alone is easy to miss
  // mid-work). Reading the monitoring thread clears it through the same
  // visit timestamp the sidebar uses.
  const allThreadShells = useThreadShells();
  const watcherThreadRef = useMemo(() => {
    if (!activeThread) return null;
    const project = allProjects.find(
      (candidate) =>
        candidate.id === activeThread.projectId &&
        candidate.environmentId === activeThread.environmentId,
    );
    const threadId = project?.workspaceControl?.monitoring?.threadId ?? null;
    if (threadId === null || threadId === activeThread.id) return null;
    return scopeThreadRef(activeThread.environmentId, threadId);
  }, [activeThread, allProjects]);
  const watcherThreadKey = watcherThreadRef === null ? null : scopedThreadKey(watcherThreadRef);
  const watcherLastVisitedAt = useUiStateStore((store) =>
    watcherThreadKey === null ? undefined : store.threadLastVisitedAtById[watcherThreadKey],
  );
  const watcherBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (watcherThreadRef === null) return null;
    const shell = allThreadShells.find(
      (candidate) =>
        candidate.id === watcherThreadRef.threadId &&
        candidate.environmentId === watcherThreadRef.environmentId &&
        candidate.archivedAt === null,
    );
    if (!shell) return null;
    const asking = shell.hasPendingUserInput;
    const reported = hasUnseenCompletion({ ...shell, lastVisitedAt: watcherLastVisitedAt });
    if (!asking && !reported) return null;
    const at = shell.latestTurn?.completedAt ?? shell.updatedAt;
    const clock = new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    return {
      id: `watcher:${watcherThreadKey}`,
      variant: asking ? "warning" : "info",
      icon: <EyeIcon />,
      title: asking ? "감시 AI가 묻고 있습니다" : `감시 AI의 새 보고 (${clock})`,
      description: asking
        ? "감시 스레드에서 답을 기다리는 질문이 있습니다."
        : "감시 스레드에 새 발견이 올라왔습니다.",
      actions: (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: {
                environmentId: watcherThreadRef.environmentId,
                threadId: watcherThreadRef.threadId,
              },
            })
          }
        >
          감시 스레드 열기
        </Button>
      ),
    };
  }, [allThreadShells, navigate, watcherLastVisitedAt, watcherThreadKey, watcherThreadRef]);
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: urgent system banners (error/warning variants plus
  // calm-styled live states flagged `urgent`, like update progress), then
  // background liveness — its Stop button is the only stop affordance for
  // settled turns, so a passive "update available" notice must not cover it —
  // then calm system banners, the woke and branch-mismatch notices, and the
  // informational parked-thread banner last — it must never cover another.
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadSnoozed && !activeThreadSettled) {
      return null;
    }
    const isSnoozed = activeThreadSnoozed;
    return {
      id: `thread-${isSnoozed ? "snoozed" : "settled"}:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `이 대화는 ${isSnoozed ? "다시 알림 대기 중" : "완료됨"} 상태입니다`,
      description: isSnoozed
        ? "메시지를 보내면 대화를 깨우고 사이드바의 활성 목록으로 옮깁니다."
        : "메시지를 보내면 사이드바의 활성 목록으로 옮깁니다.",
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={isSnoozed ? isUnsnoozing : isUnsettling}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? "깨우는 중..."
              : "지금 깨우기"
            : isUnsettling
              ? "완료 해제 중..."
              : "완료 해제"}
        </Button>
      ),
    };
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
  ]);
  const handleRestoreThreadBranch = useCallback(() => {
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread]);
  // A live meeting owns this conversation: say so, and give the person the
  // stop control right where they are typing — "멈추라면 멈춰야지".
  const meetingRunBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (liveMeetingRun === undefined) return null;
    const cancelling = liveMeetingRun.status === "cancel-requested";
    const isDirectCollaboration = liveMeetingRun.meeting?.maxRounds === 0;
    const kindLabel = isDirectCollaboration ? "오케스트라 · 바로 실행" : "오케스트라 · 토론";
    const phaseLabel = cancelling
      ? "중지 중"
      : liveMeetingRun.meeting?.phase === "executing"
        ? "실행 단계"
        : liveMeetingRun.meeting?.pendingQuestion
          ? "답변 대기"
          : liveMeetingRun.status === "queued"
            ? "시작 대기"
            : liveMeetingRun.meeting?.phase === "clarifying"
              ? "지휘 AI 확인 중"
              : isDirectCollaboration
                ? "계획 수립 중"
                : "논의 진행 중";
    return {
      id: `meeting-run:${liveMeetingRun.id}`,
      variant: "info",
      icon: <UsersIcon />,
      title: (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium">
            {kindLabel} · {phaseLabel}
          </span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            보내는 메시지는 오케스트라{isDirectCollaboration ? "" : " 토론"}으로 전달됩니다
          </span>
        </span>
      ),
      className: "dark:shadow-none",
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            disabled={cancelling}
            onClick={() => void handleStopMeetingRun()}
          >
            <SquareIcon />
            {cancelling ? "중지 중..." : "오케스트라 중지"}
          </Button>
        </>
      ),
    };
  }, [handleStopMeetingRun, liveMeetingRun]);
  // The way back out of a node conversation. It is not in the conversation
  // list, so without this the person who opened one is stranded in it.
  const orchestraOwnerThreadId = activeServerThread?.orchestraRunThreadId ?? null;
  const orchestraNodeOriginBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (orchestraOwnerThreadId === null) return null;
    return {
      id: `orchestra-node-of:${orchestraOwnerThreadId}`,
      variant: "info",
      icon: <UsersIcon />,
      title: (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium">오케스트라 노드 대화</span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            오케스트라가 이 작업을 실행한 대화입니다
          </span>
        </span>
      ),
      className: "dark:shadow-none",
      actions: (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: orchestraOwnerThreadId },
            })
          }
        >
          오케스트라 대화 열기
        </Button>
      ),
    };
  }, [environmentId, navigate, orchestraOwnerThreadId]);
  // This conversation is the project's monitoring thread and the AI has put a
  // watch plan on the table: approval is a button here, not a chat reply — a
  // reply cannot be validated as consent and would cost a turn to interpret.
  const monitoring = activeProject?.workspaceControl?.monitoring;
  const monitoringProjectId = activeProject?.id;
  const monitoringPlanBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (
      monitoring === undefined ||
      monitoringProjectId === undefined ||
      monitoring.threadId === null ||
      monitoring.threadId !== activeThreadId ||
      monitoring.planStatus !== "proposed" ||
      monitoring.plan === null
    ) {
      return null;
    }
    const plan = monitoring.plan;
    return {
      id: `monitoring-plan:${plan.revision}`,
      variant: "info",
      icon: <EyeIcon />,
      title: (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium">감시 계획 제안 · {plan.revision}판</span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            대상 {plan.targets.length} · 지표 {plan.metrics.length} · 플레이북{" "}
            {plan.playbooks.length}
            {" — 승인하면 이 계획대로 감시를 시작합니다"}
          </span>
        </span>
      ),
      className: "dark:shadow-none",
      actions: (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void approveMonitoringPlan({
              environmentId,
              input: { projectId: monitoringProjectId, revision: plan.revision },
            }).then((result) => {
              if (result._tag !== "Success") {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "감시 계획 승인 실패",
                    description: "제어센터에서 계획 상태를 확인해 주세요.",
                  }),
                );
              }
            })
          }
        >
          <CheckIcon />
          승인
        </Button>
      ),
    };
  }, [activeThreadId, approveMonitoringPlan, environmentId, monitoring, monitoringProjectId]);
  const composerBannerItems = useComposerBannerItems({
    systemComposerBannerItems,
    orchestraNodeOriginBannerItem,
    meetingRunBannerItem,
    monitoringPlanBannerItem,
    backgroundLivenessBannerItem,
    backgroundWatchBannerItem,
    wokeThreadBannerItem,
    watcherBannerItem,
    parkedThreadBannerItem,
    localCheckoutBranchMismatch,
    showBranchMismatchBanner,
    activeBranchMismatchKey,
    isRestoringThreadBranch,
    handleRestoreThreadBranch,
    setBranchMismatchDismissTick,
  });

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalUiState.terminalOpen) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen]);

  useChatViewShortcuts({
    isForeground,
    activeThreadId,
    activeProject,
    activeRightPanelSurface,
    terminalOpen: Boolean(terminalUiState.terminalOpen),
    activeTerminalId: terminalUiState.activeTerminalId,
    keybindings,
    composerRef,
    toggleTerminalVisibility,
    toggleRightPanel,
    setTerminalOpen,
    splitTerminal,
    splitPanelTerminal,
    closeTerminal,
    closePanelTerminal,
    createNewTerminal,
    addTerminalSurface,
    onToggleDiff,
    runProjectScript,
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const localApi = readLocalApi();
      if (!localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `체크포인트로 되돌리기 전에 ${activeEnvironmentUnavailableLabel}에 다시 연결하세요.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "체크포인트로 되돌리기 전에 현재 턴을 중단하세요.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `이 대화를 체크포인트 ${turnCount}(으)로 되돌릴까요?`,
          "이 체크포인트 이후의 메시지와 변경 내역이 삭제됩니다.",
          "이 작업은 되돌릴 수 없습니다.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.error(error);
        setThreadError(activeThread.id, "대화를 체크포인트로 되돌리지 못했습니다.");
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
    ],
  );

  const draftCreation = (
    title: string,
    modelSelection: ModelSelection,
    mode: ProviderInteractionMode,
  ) =>
    buildDraftThreadCreateBootstrap(
      isLocalDraftThread ? draftThread : null,
      localDraftId,
      {
        title,
        modelSelection,
        runtimeMode,
        interactionMode: mode,
      },
      draftThread ? settings.threadResponseStyles?.[draftThread.threadId] : undefined,
    );

  const onSend = async (
    e?: { preventDefault: () => void },
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
    approvedTask?: { contextKey: string; conditions: ApprovedTaskConditions },
    voiceOnly?: { text: string; sent: () => void; attempted: () => void },
  ) => {
    e?.preventDefault();
    if (
      voiceOnly &&
      (phase === "running" ||
        activePendingProgress ||
        activePendingApproval ||
        activePendingUserInput ||
        isRevertingCheckpoint ||
        (developmentEnabled && developmentTarget.workspaceId) ||
        liveMeetingRun !== undefined ||
        readMeetingComposerConfig().enabled ||
        showPlanFollowUpPrompt ||
        readComposerRequestMode() === "conditions" ||
        voiceOnly.text.trim().startsWith("/"))
    )
      return;
    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "주석을 임시 작성 내용에 첨부했습니다",
          description: "지금은 보낼 수 없습니다. 현재 작업을 마친 뒤 보내세요.",
        }),
      );
    };
    if (isSendLocked()) {
      // A visible hold beats a silent drop: the person must never wonder
      // whether the app ignored them.
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "이전 메시지를 보내는 중입니다",
          description: "전송이 끝난 직후 다시 시도하세요.",
        }),
      );
      return;
    }
    if (
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      threadDetailLoading ||
      (dedicatedRoom && (!serverThread || dedicatedRoom.sendDisabledReason))
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (activeEnvironmentUnavailable) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "연결되지 않아 메시지를 보내지 못했습니다",
          description: "실행 환경에 다시 연결 중입니다. 연결된 뒤 다시 시도하세요.",
        }),
      );
      return;
    }
    if (
      activePendingProgress &&
      !(developmentEnabled && developmentTarget.workspaceId && !directAnnotation)
    ) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const draftSendCtx = composerRef.current?.getSendContext();
    const sendCtx = voiceOnly && draftSendCtx ? isolateVoiceContext(draftSendCtx) : draftSendCtx;
    if (
      !sendCtx ||
      (!sendCtx.providerAvailable &&
        !(
          desktopAssistantCharacter === undefined &&
          developmentEnabled &&
          developmentTarget.workspaceId &&
          !directAnnotation
        ))
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    const {
      images: sendContextImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      reviewComments: composerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      workflowModelSelection: ctxWorkflowModelSelection,
    } = sendCtx;
    if (
      !assistantModelMatches(
        desktopAssistantCharacter,
        desktopAssistantModelSelection,
        ctxSelectedModelSelection,
      )
    ) {
      toastManager.add({
        type: "error",
        title: "설정한 비서 모델을 사용할 수 없습니다. 비서 설정을 확인하세요.",
      });
      return;
    }
    const composerImages =
      directAnnotation?.image &&
      !sendContextImages.some((image) => image.id === directAnnotation.image?.id)
        ? [...sendContextImages, directAnnotation.image]
        : sendContextImages;
    const composerPreviewAnnotations =
      directAnnotation &&
      !sendContextPreviewAnnotations.some(
        (annotation) => annotation.id === directAnnotation.annotation.id,
      )
        ? [
            ...sendContextPreviewAnnotations,
            {
              ...directAnnotation.annotation,
              screenshot: directAnnotation.annotation.screenshot
                ? { ...directAnnotation.annotation.screenshot, dataUrl: "" }
                : null,
            },
          ]
        : sendContextPreviewAnnotations;
    const promptForSend = voiceOnly?.text ?? promptRef.current;
    const requestMode = readComposerRequestMode();
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerElementContexts.length +
        composerPreviewAnnotations.length +
        composerReviewComments.length,
    });
    const conditionMeeting = readMeetingComposerConfig();
    const conditionWorkOnlyReason =
      !directAnnotation &&
      ((developmentEnabled && developmentTarget.workspaceId) ||
        (conditionMeeting.enabled && !developmentEnabled) ||
        (showPlanFollowUpPrompt && activeProposedPlan))
        ? "현재 선택한 협업·계획 실행 경로는 실행 작업을 전달합니다."
        : null;
    const conditionContextKey = JSON.stringify([
      environmentId,
      activeThread.id,
      activeProject?.workspaceRoot,
      promptForSend,
      composerImages.map((image) => [image.id, image.name, image.sizeBytes]),
      composerTerminalContexts,
      composerElementContexts,
      composerPreviewAnnotations,
      composerReviewComments,
      ctxSelectedModelSelection,
      activeThread.runtimeMode,
      activeThread.interactionMode,
      developmentEnabled,
      developmentTarget,
      conditionMeeting,
      conditionWorkOnlyReason,
      requestMode,
    ]);
    if (approvedTask && approvedTask.contextKey !== conditionContextKey) {
      setPendingTaskConditions(null);
      toastManager.add({
        type: "warning",
        title: "요청이나 첨부 내용이 변경됐습니다. 조건을 다시 확인하세요.",
      });
      return;
    }
    if (approvedTask?.conditions.mode === "inspect" && conditionWorkOnlyReason) {
      toastManager.add({ type: "warning", title: "조회 전용 작업은 일반 대화에서 보내세요." });
      return;
    }
    if (
      !approvedTask &&
      requestMode === "conditions" &&
      hasSendableContent &&
      !liveMeetingRun &&
      !/^(stop|cancel|멈춰|멈춰줘|중지|중단|그만)$/i.test(trimmed)
    ) {
      setPendingTaskConditions((previous) =>
        previous?.contextKey === conditionContextKey
          ? previous
          : {
              contextKey: conditionContextKey,
              threadId: activeThread.id,
              draft: createTaskConditionsDraft(promptForSend, activeProject?.workspaceRoot ?? ""),
              ...(conditionWorkOnlyReason ? { workOnlyReason: conditionWorkOnlyReason } : {}),
              ...(directAnnotation ? { directAnnotation } : {}),
            },
      );
      return;
    }
    if (
      developmentEnabled &&
      developmentTarget.workspaceId &&
      activeProject &&
      activeThread &&
      !directAnnotation
    ) {
      if (
        composerImages.length ||
        composerElementContexts.length ||
        composerPreviewAnnotations.length ||
        composerReviewComments.length ||
        sendableComposerTerminalContexts.length
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Owner 직접 지시는 현재 텍스트 입력을 지원합니다.",
            description: "첨부 내용은 Main에게 보내거나 텍스트로 정리하세요.",
          }),
        );
        return;
      }
      const workspace = developmentState?.workspaces.find(
        (workspace) => workspace.id === developmentTarget.workspaceId,
      );
      if (!workspace || !trimmed) return;
      beginSendInFlight();
      try {
        const settingsResult = await persistThreadSettingsForNextTurn({
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          runtimeMode,
          interactionMode,
        });
        if (settingsResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(settingsResult)) {
            setThreadError(activeThread.id, "작업실 실행 설정을 저장하지 못했습니다.");
          }
          return;
        }
        const result = await sendDevelopmentInput({
          environmentId,
          input: {
            projectId: activeProject.id,
            conversationId: activeThread.id,
            workspaceId: workspace.id,
            commandId: CommandId.make(randomUUID()),
            expectedRevision: workspace.stateRevision,
            text: approvedTask
              ? renderApprovedTaskConditions(approvedTask.conditions, trimmed)
              : formatComposerRequest(trimmed, requestMode),
            mode: developmentTarget.mode,
            requirementChange: developmentTarget.requirementChange,
          },
        });
        if (result._tag === "Success") {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        }
      } finally {
        sendInFlightRef.current = false;
      }
      return;
    }
    if (!directAnnotation && showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: approvedTask
          ? renderApprovedTaskConditions(approvedTask.conditions, followUp.text)
          : formatComposerRequest(followUp.text, requestMode),
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    // Legacy plan mode: /plan and /default only act when the beta flag is on;
    // otherwise they send as plain text like any other message.
    const standaloneSlashCommand =
      settings.planModeEnabled &&
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    const missionSlashMatch = trimmed.match(/^\/(?:mission|미션)(?:\s+([\s\S]+))?$/i);
    if (missionSlashMatch && isServerThread && activeProject) {
      const missionGoal = missionSlashMatch[1]?.trim() ?? "";
      if (!missionGoal) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "자율 미션 사용법",
            description: "/mission 뒤에 크루들이 자율적으로 완료할 목표를 입력해 주세요.",
          }),
        );
        return;
      }
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      try {
        const res = await createMissionInThreadCmd({
          environmentId: activeThread.environmentId,
          input: {
            projectId: activeProject.id,
            threadId: activeThread.id,
            createNewThread: false,
            goalPrompt: missionGoal,
            requireFinalApproval: true,
          },
        });
        if (res._tag === "Failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "자율 미션 시작 실패",
              description:
                "자율 미션 실행 요청이 거부되었습니다. 긴급 중지나 예산 한도를 확인해 주세요.",
            }),
          );
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "이 대화창에서 자율 미션을 시작했습니다",
            description: "진행·교신·결재 및 완료 보고가 현재 대화창과 자율 운영실에 동기화됩니다.",
          }),
        );
      } catch (err) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "자율 미션 시작 실패",
            description: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "먼저 프로젝트를 선택하세요",
          description: "이 임시 작성 내용이 더 이상 사용 가능한 프로젝트를 가리키지 않습니다.",
        }),
      );
      return;
    }

    // A live meeting in THIS conversation claims every send, whether or not
    // meeting mode is armed: a plain turn started into the meeting thread
    // would replace the seat's in-flight turn and kill the run. A run that is
    // queued or running IS live no matter how long it has been silent — a
    // long seat turn is not a dead meeting, and falling through to a plain
    // send would spawn a NEW meeting out of the person's message.
    const meetingThreadId = isServerThread || isLocalDraftThread ? activeThread.id : undefined;
    const liveMeetingRunHere = liveMeetingRun;
    if (liveMeetingRunHere !== undefined && directAnnotation) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "통합 작업이 진행 중입니다",
          description:
            "이미지 검토는 작업 종료 후 보내거나, 필요한 내용을 감독 AI에게 텍스트로 전달하세요.",
        }),
      );
      return;
    }
    // "멈춰"/"중지" is a stop command wherever a meeting could be listening.
    // It must never convene a meeting and never become a debate topic — even
    // when the runs query is mid-flight and no live run is visible yet.
    const stopIntentText = promptForSend.trim().replace(/[\s.!?~…ㅋㅎ;,]+$/g, "");
    const stopIntentPattern =
      /^(애|얘|야)?\s*(회의|미팅|오케스트라)?\s*(멈춰|멈춰라|멈춰줘|멈추라고|중지|중지해|중지해줘|중단|중단해|중단해줘|그만|그만해|그만해라|스탑|스톱|stop|cancel)$/i;
    if (
      !directAnnotation &&
      stopIntentPattern.test(stopIntentText) &&
      (liveMeetingRunHere !== undefined || readMeetingComposerConfig().enabled)
    ) {
      await handleStopMeetingRun();
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (liveMeetingRunHere !== undefined && !directAnnotation) {
      // A dying meeting must not swallow the person's words: while the cancel
      // is settling, hold the message instead of filing it as an interjection
      // nobody will ever read.
      if (liveMeetingRunHere.status === "cancel-requested") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "오케스트라를 중지하는 중입니다",
            description: "중지가 끝난 뒤 다시 보내면 일반 메시지로 전달됩니다.",
          }),
        );
        return;
      }
      const meetingPendingQuestion = liveMeetingRunHere.meeting?.pendingQuestion ?? null;
      if (meetingPendingQuestion !== null) {
        // The run is parked on a question for the person; a message typed
        // into its own conversation IS the answer — send it as one so the
        // meeting wakes up, instead of an interjection it would never read.
        if (composerImages.some((item) => item.type !== "image")) {
          toastManager.add({ type: "warning", title: "질문에는 이미지 파일을 첨부하세요." });
          return;
        }
        const attachments = [...composerImages];
        const prepared = prepareOrchestraMessage(promptForSend);
        if (prepared.kind === "too-long") {
          toastManager.add({ title: "답변은 8,000자 이하로 입력하세요.", type: "warning" });
          return;
        }
        const answerText =
          prepared.text || (attachments.length ? "첨부한 이미지를 참고하세요." : "");
        if (answerText.length === 0) return;
        beginSendInFlight();
        try {
          const images = await uploadMeetingQuestionImages(attachments);
          const answered = await answerMeetingRun({
            environmentId,
            input: {
              runId: liveMeetingRunHere.id,
              projectId: liveMeetingRunHere.projectId,
              question: meetingPendingQuestion.question,
              questionRef: {
                nodeId: meetingPendingQuestion.nodeId,
                askedAt: meetingPendingQuestion.askedAt,
              },
              answer: answerText,
              ...(images.length ? { images } : {}),
            },
          });
          if (answered._tag === "Failure") {
            if (!isAtomCommandInterrupted(answered)) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "오케스트라 질문에 답변을 보내지 못했습니다",
                  description: "연결 상태를 확인하고 다시 시도하세요.",
                }),
              );
            }
            return;
          }
          for (const image of attachments) removeComposerDraftImage(composerDraftTarget, image.id);
          if (promptRef.current === promptForSend) {
            promptRef.current = "";
            setComposerDraftPrompt(composerDraftTarget, "");
            composerRef.current?.resetCursorState();
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "오케스트라 질문에 답변했습니다",
              description: "답변을 반영해 오케스트라가 이어집니다.",
            }),
          );
        } catch {
          toastManager.add({ type: "error", title: "질문에 첨부한 이미지를 읽지 못했습니다." });
        } finally {
          sendInFlightRef.current = false;
        }
        return;
      }
      if (composerImages.length > 0) {
        toastManager.add({
          type: "warning",
          title: "진행 중인 논의에는 아직 사진을 추가할 수 없습니다.",
          description: "첨부한 사진은 작성창에 보관됩니다.",
        });
        return;
      }
      const prepared = prepareOrchestraMessage(promptForSend);
      if (prepared.kind === "too-long") {
        toastManager.add({ title: "추가 지시는 8,000자 이하로 입력하세요.", type: "warning" });
        return;
      }
      const interjectionText = prepared.text;
      if (interjectionText.length === 0) return;
      beginSendInFlight();
      try {
        const interjected = await interjectMeetingRun({
          environmentId,
          input: {
            runId: liveMeetingRunHere.id,
            projectId: liveMeetingRunHere.projectId,
            text: interjectionText,
          },
        });
        if (interjected._tag === "Failure") {
          if (!isAtomCommandInterrupted(interjected)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "오케스트라에 발언을 전달하지 못했습니다",
                description: "연결 상태를 확인하고 다시 시도하세요.",
              }),
            );
          }
          return;
        }
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "감독 AI에게 추가 지시를 전달했습니다",
            description: "감독 AI의 다음 판단에 반영됩니다.",
          }),
        );
      } finally {
        sendInFlightRef.current = false;
      }
      return;
    }

    // An armed meeting turns the composer text into a collaboration-run topic:
    // the roster discusses it, agrees a plan, and executes it — no thread turn
    // is started, so this leaves the current conversation untouched.
    const meetingDraft = readMeetingComposerConfig();
    const meetingConversationKey = activeMeetingConversationKey();
    if (meetingDraft.enabled && !developmentEnabled && !directAnnotation) {
      if (!ctxWorkflowModelSelection) {
        toastManager.add({
          type: "warning",
          title: "선택한 대화 모델을 확인할 수 없습니다. 모델 설정을 확인하세요.",
        });
        return;
      }
      // Never convene a meeting while this conversation's meeting state is
      // still unknown — a moment of unloaded query data must not turn a
      // message meant for a live meeting into a brand-new one. Refresh so an
      // errored query cannot leave the composer blocked forever.
      if (isServerThread && meetingRunsQuery.data == null) {
        meetingRunsQuery.refresh();
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "오케스트라 상태를 확인하는 중입니다",
            description: "잠시 후 다시 보내면 전달됩니다.",
          }),
        );
        return;
      }
      if (composerImages.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "오케스트라 주제에는 파일을 첨부할 수 없습니다",
            description: "첨부 파일을 제거하거나 오케스트라를 끄고 보내세요.",
          }),
        );
        return;
      }
      if (meetingDraft.seats.length < 1) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "감독 AI가 지정되지 않았습니다",
            description: "AI 작업 설정에서 감독 AI를 선택하세요.",
          }),
        );
        return;
      }
      const coordinator = selectIndependentMeetingCoordinator(
        meetingSetupFromConfig(meetingDraft),
        ctxSelectedModelSelection,
      );
      if (!coordinator.meeting) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "선택한 총괄 모델을 사용할 수 없습니다",
            description: coordinator.error ?? "참가자 구성을 확인하세요.",
          }),
        );
        return;
      }
      const meetingTopic = appendReviewCommentsToPrompt(
        composerPreviewAnnotations.reduce(
          (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
          appendElementContextsToPrompt(
            appendTerminalContextsToPrompt(promptForSend, sendableComposerTerminalContexts),
            composerElementContexts,
          ),
        ),
        composerReviewComments,
      ).trim();
      if (meetingTopic.length === 0) return;
      const meetingTask = executionProfileTask(
        approvedTask
          ? renderApprovedTaskConditions(approvedTask.conditions, meetingTopic)
          : meetingTopic,
        meetingDraft.executionProfile,
      );
      if (meetingTask.length > 20_000) {
        toastManager.add({
          type: "warning",
          title: "작업과 프로필 지침을 합쳐 20,000자 이하로 입력하세요.",
        });
        return;
      }
      const prepareMeetingWorktree =
        activeThread.messages.length === 0 &&
        sendEnvMode === "worktree" &&
        !activeThread.worktreePath;
      if (prepareMeetingWorktree && !activeThreadBranch) {
        toastManager.add({ type: "warning", title: "작업 트리의 기준 브랜치를 선택하세요." });
        return;
      }
      beginSendInFlight();
      if (isLocalDraftThread) trackDraftWorkflowStart(true);
      try {
        const result = await requestMeetingRun({
          environmentId,
          input: {
            projectId: activeProject.id,
            task: meetingTask,
            userMessage: meetingTopic,
            requestId: randomUUID(),
            requestMode,
            conditionsConfirmed: requestMode !== "conditions" || !!approvedTask,
            runtimeMode,
            interactionMode: workflowInteractionMode,
            ...(meetingThreadId !== undefined ? { threadId: meetingThreadId } : {}),
            ...(isLocalDraftThread || prepareMeetingWorktree
              ? {
                  bootstrap: {
                    ...draftCreation(
                      truncate(meetingTopic),
                      ctxWorkflowModelSelection,
                      workflowInteractionMode,
                    ),
                    ...(prepareMeetingWorktree && activeThreadBranch
                      ? {
                          prepareWorktree: {
                            projectCwd: activeProject.workspaceRoot,
                            baseBranch: activeThreadBranch,
                            branch: buildTemporaryWorktreeBranchName(randomHex),
                            startFromOrigin,
                          },
                          runSetupScript: true,
                        }
                      : {}),
                  },
                }
              : {}),
            meeting: {
              ...coordinator.meeting,
              askFirst: !approvedTask && requestMode === "ask-first",
              runtimeMode,
              interactionMode: workflowInteractionMode,
              ...(meetingThreadId !== undefined ? { threadId: meetingThreadId } : {}),
            },
            // 오케스트라는 상시 모드다: armed면 항상 병렬 실행 설정을 싣는다
            // (폭 1이면 순차 실행과 동일). 예전 opt-in 플래그는 보지 않는다.
            orchestra: {
              executionMode: meetingDraft.executionMode ?? "once",
              maxParallel: meetingDraft.maxParallel,
              isolateWorktrees: meetingDraft.isolateWorktrees,
              reviewPlan: meetingDraft.reviewPlan === true,
              resumeAfterLimit: meetingDraft.resumeAfterLimit === true,
              verificationCommands: (meetingDraft.verificationCommands ?? [])
                .map((command) => command.trim())
                .filter(Boolean),
              ...(meetingDraft.maxWorkerTurns === undefined
                ? {}
                : { maxWorkerTurns: meetingDraft.maxWorkerTurns }),
              ...(meetingDraft.executionMode !== "persistent" ||
              meetingDraft.watchdogIntervalSeconds === undefined
                ? {}
                : { watchdogIntervalSeconds: meetingDraft.watchdogIntervalSeconds }),
            },
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "오케스트라를 시작하지 못했습니다",
                description: "연결 상태를 확인하고 다시 시도하세요.",
              }),
            );
          }
          return;
        }
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
        disarmMeetingComposer(meetingConversationKey);
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title:
              meetingDraft.style === "collaboration"
                ? "오케스트라(바로 실행)를 시작했습니다"
                : "오케스트라 토론을 시작했습니다",
            description:
              meetingThreadId !== undefined
                ? `${meetingDraft.seats.map((seat) => seat.displayName).join(", ")} — ${
                    meetingDraft.style === "collaboration"
                      ? "계획 수립 후 분담 실행이 이 대화창에서 진행됩니다."
                      : "논의가 이 대화창에서 실시간으로 진행됩니다."
                  }`
                : `${meetingDraft.seats
                    .map((seat) => seat.displayName)
                    .join(", ")} — 새 대화창에서 진행됩니다. 제어 센터에서도 볼 수 있습니다.`,
          }),
        );
      } finally {
        sendInFlightRef.current = false;
        if (isLocalDraftThread) trackDraftWorkflowStart(false);
      }
      return;
    }
    if (
      shouldWaitForActiveModelBeforeSending({
        session: activeThread.session,
        currentModelSelection: activeThread.modelSelection,
        nextModelSelection: ctxSelectedModelSelection,
      })
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "선택한 AI는 다음 작업부터 사용합니다",
          description: "현재 작업이 끝난 뒤 작성 중인 메시지를 보내세요.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(
        threadIdForSend,
        "새 작업 트리 모드에서 보내기 전에 기준 브랜치를 선택하세요.",
      );
      return;
    }

    beginSendInFlight();
    if (isDraftHeroState && activeThreadKey) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(() => {
        flushSync(() => {
          captureDraftHeroComposerRect();
          setDockedDraftHeroThreadKey(activeThreadKey);
        });
        resolveDockStarted?.();
      });
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerElementContextsSnapshot = [...composerElementContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const messageTextWithContexts = appendElementContextsToPrompt(
      appendTerminalContextsToPrompt(promptForSend, composerTerminalContextsSnapshot),
      composerElementContextsSnapshot,
    );
    const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
      (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
      messageTextWithContexts,
    );
    const assembledMessageText = appendReviewCommentsToPrompt(
      messageTextWithPreviewAnnotations,
      composerReviewCommentsSnapshot,
    );
    const messageTextForSend = formatComposerRequest(
      assembledMessageText || IMAGE_ONLY_BOOTSTRAP_PROMPT,
      approvedTask ? "conditions" : requestMode,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: image.type,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: image.type,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    // Sending always returns to the live edge. The new row becomes the
    // anchored end-space target so it lands near the top while the response
    // streams into the reserved space below it.
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = messageIdForSend;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({
      threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageId: messageIdForSend,
    });
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        turnId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    if (!voiceOnly) {
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
    }

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = approvedTask?.conditions.goal ?? trimmed;
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `첨부 파일: ${firstComposerImageName}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerElementContextsSnapshot.length > 0) {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!);
      } else {
        titleSeed = "새 대화";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    // Auto-title from first message
    if (isFirstMessage && isServerThread && !dedicatedRoom) {
      const titleResult = await updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      });
      if (titleResult._tag === "Failure") {
        failure = titleResult;
      }
    }

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel && desktopAssistantCharacter === undefined
          ? { modelSelection: ctxSelectedModelSelection }
          : {}),
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(() => turnAttachmentsPromise);
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...draftCreation(title, threadCreateModelSelection, interactionMode),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      beginLocalDispatch({ preparingWorktree: false });
      voiceOnly?.attempted();
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachmentsResult.value,
          },
          modelSelection: ctxSelectedModelSelection,
          ...(desktopAssistantCharacter !== undefined ? { desktopAssistantCharacter } : {}),
          titleSeed: title,
          ...(approvedTask
            ? {
                requireTaskConditions: true,
                taskConditions: approvedTask.conditions,
              }
            : {}),
          runtimeMode,
          interactionMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt: messageCreatedAt,
        },
      });
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        voiceOnly?.sent();
        acknowledgeActiveThreadWoke();
      }
    }

    if (failure !== null) {
      if (voiceOnly) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
      }
      if (
        !voiceOnly &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerElementContextsRef.current.length === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.previewAnnotations
          .length ?? 0) === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
          .length ?? 0) === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        composerElementContextsRef.current = composerElementContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftElementContexts(composerDraftTarget, composerElementContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        setThreadError(threadIdForSend, "메시지를 보내지 못했습니다.");
      }
    }
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      resetLocalDispatch();
    }
  };

  const handledVoiceRequest = useRef<string | null>(null);
  useEffect(() => {
    const request = props.desktopAssistantVoiceRequest;
    if (!request || handledVoiceRequest.current === request.id) return;
    handledVoiceRequest.current = request.id;
    void (async () => {
      let sent = false;
      let attempted = false;
      try {
        await onSend(undefined, undefined, undefined, {
          text: request.text,
          sent: () => {
            sent = true;
          },
          attempted: () => {
            attempted = true;
          },
        });
      } catch {
        /* Preserve the transcript for an explicit retry. */
      } finally {
        props.onDesktopAssistantVoiceHandled?.(
          request.id,
          sent ? "sent" : attempted ? "unknown" : "blocked",
        );
      }
    })();
  }, [props.desktopAssistantVoiceRequest]);

  const onInterrupt = async () => {
    if (!activeThread) return;
    if (liveMeetingRun !== undefined) {
      await handleStopMeetingRun();
      return;
    }
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(
        activeThread,
        activePendingUserInput && isRecoverableUserInputRequestId(activePendingUserInput.requestId)
          ? { questionRequestId: activePendingUserInput.requestId }
          : undefined,
      ),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setThreadError(activeThread.id, "현재 턴을 중단하지 못했습니다.");
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setThreadError(activeThreadId, "승인 결정을 제출하지 못했습니다.");
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onAddPendingQuestionImages = useCallback(
    (requestId: ApprovalRequestId, questionId: string, images: ComposerImageAttachment[]) => {
      if (!activeThreadId) return;
      const tracked = pendingQuestionImageUrlsRef.current.get(requestId) ?? {
        threadId: activeThreadId,
        urls: new Set<string>(),
      };
      for (const image of images) {
        if (image.previewUrl.startsWith("blob:")) tracked.urls.add(image.previewUrl);
      }
      pendingQuestionImageUrlsRef.current.set(requestId, tracked);
      setPendingUserInputAnswersByRequestId((existing) => {
        const answers = existing[requestId] ?? {};
        const draft = answers[questionId] ?? {};
        return {
          ...existing,
          [requestId]: {
            ...answers,
            [questionId]: { ...draft, images: [...(draft.images ?? []), ...images] },
          },
        };
      });
    },
    [activeThreadId],
  );
  const onRemovePendingQuestionImage = useCallback(
    (requestId: ApprovalRequestId, questionId: string, imageId: string) => {
      setPendingUserInputAnswersByRequestId((existing) => {
        const answers = existing[requestId];
        const draft = answers?.[questionId];
        const removed = draft?.images?.find((image) => image.id === imageId);
        if (!answers || !draft || !removed) return existing;
        if (removed.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(removed.previewUrl);
          pendingQuestionImageUrlsRef.current.get(requestId)?.urls.delete(removed.previewUrl);
        }
        return {
          ...existing,
          [requestId]: {
            ...answers,
            [questionId]: {
              ...draft,
              images: draft.images!.filter((image) => image.id !== imageId),
            },
          },
        };
      });
    },
    [],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        const drafts = pendingUserInputAnswersByRequestId[requestId] ?? {};
        const images = await Promise.all(
          Object.entries(drafts).flatMap(([questionId, draft]) =>
            (draft.images ?? []).map(async (image) => ({
              questionId,
              image: {
                type: "image" as const,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl: await readFileAsDataUrl(image.file),
              },
            })),
          ),
        );
        const result = await respondToThreadUserInput({
          environmentId,
          input: {
            threadId: activeThreadId,
            requestId,
            answers,
            ...(images.length ? { images } : {}),
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          setThreadError(activeThreadId, "입력 내용을 제출하지 못했습니다.");
        }
        return result;
      } catch {
        setThreadError(activeThreadId, "질문에 첨부한 이미지를 읽지 못했습니다.");
      } finally {
        setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [
      activeThreadId,
      environmentId,
      pendingUserInputAnswersByRequestId,
      respondToThreadUserInput,
      setThreadError,
    ],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
      focusEditor = true,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        focusEditor &&
        (snapshot?.value !== value ||
          snapshot?.cursor !== nextCursor ||
          snapshot?.expandedCursor !== expandedCursor)
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    // The primary button is disabled until the question is answered, but Enter
    // in the composer lands here ungated — so it used to walk past unanswered
    // questions and then sit dead on the last one. Resolve both through the
    // same rule, and say something instead of swallowing the keystroke.
    const advance = resolvePendingUserInputAdvance(
      activePendingUserInput.questions,
      activePendingDraftAnswers,
      activePendingProgress.questionIndex,
    );
    if (advance.kind === "submit") {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    if (advance.kind === "next") {
      setActivePendingUserInputQuestionIndex(advance.questionIndex);
      return;
    }
    if (advance.questionIndex !== activePendingProgress.questionIndex) {
      setActivePendingUserInputQuestionIndex(advance.questionIndex);
    }
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "아직 답하지 않은 질문이 있습니다",
        description: "보기를 고르거나 직접 답변을 입력한 뒤 계속하세요.",
      }),
    );
  }, [
    activePendingDraftAnswers,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      if (!activeThread || !isServerThread || isSendBusy || isConnecting || isSendLocked()) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;
      if (
        !assistantModelMatches(
          desktopAssistantCharacter,
          desktopAssistantModelSelection,
          ctxSelectedModelSelection,
        )
      ) {
        toastManager.add({
          type: "error",
          title: "설정한 비서 모델을 사용할 수 없습니다. 비서 설정을 확인하세요.",
        });
        return;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      beginSendInFlight();
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Position this sent row once LegendList has measured the anchored tail.
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      pendingTimelineAnchorRef.current = messageIdForSend;
      activeTimelineAnchorIndexRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      setTimelineAnchor({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageId: messageIdForSend,
      });

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(desktopAssistantCharacter === undefined
          ? { modelSelection: ctxSelectedModelSelection }
          : {}),
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            ...(desktopAssistantCharacter !== undefined ? { desktopAssistantCharacter } : {}),
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        acknowledgeActiveThreadWoke();
        sendInFlightRef.current = false;
        return;
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        setThreadError(threadIdForSend, "계획 후속 메시지를 보내지 못했습니다.");
      }
      sendInFlightRef.current = false;
      resetLocalDispatch();
    },
    [
      activeThread,
      activeProposedPlan,
      acknowledgeActiveThreadWoke,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      desktopAssistantCharacter,
      desktopAssistantModelSelection,
      environmentId,
      composerRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      isSendLocked()
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    if (
      !assistantModelMatches(
        desktopAssistantCharacter,
        desktopAssistantModelSelection,
        ctxSelectedModelSelection,
      )
    ) {
      toastManager.add({
        type: "error",
        title: "설정한 비서 모델을 사용할 수 없습니다. 비서 설정을 확인하세요.",
      });
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    beginSendInFlight();
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          ...(desktopAssistantCharacter !== undefined ? { desktopAssistantCharacter } : {}),
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "시작 실패 후 구현 대화를 정리하지 못했습니다.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "구현 대화를 시작하지 못했습니다",
            description: "새 대화를 만드는 중 오류가 발생했습니다.",
          }),
        );
      }
    }
    finish();
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    startThreadTurn,
    desktopAssistantCharacter,
    desktopAssistantModelSelection,
    environmentId,
    composerRef,
  ]);

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string, options?: ModelSelection["options"]) => {
      if (!activeThread || desktopAssistantCharacter !== undefined) return;
      // Selection changes only the draft; the active turn keeps its provider.
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
        ...(options ? { options } : {}),
      };
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      desktopAssistantCharacter,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
          }),
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      primaryServerSettings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread || !activeThreadRef) return;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    },
    [activeThreadRef, isServerThread, onDiffPanelOpen],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const focusTeamEditor = () => {
    setModelSettingsPanel({ threadKey: activeThreadKey, open: true });
    if (shouldUseRightPanelSheet) closePreviewPanel();
    else if (rightPanelMaximized) setMaximizedRightPanelThreadKey(null);
    requestAnimationFrame(() => teamAddModelRef.current?.focus());
  };
  const viewerControl = <ChatViewerToggle open={viewerOpen} onToggle={toggleViewer} />;
  const workerEngineControl = (
    <ChatWorkerEngineToggle
      open={workersOpen}
      activeCount={workerEngineSummary.activeCount}
      attentionCount={workerEngineSummary.attentionCount}
      unreadCount={workerEngineSummary.unreadMailboxCount}
      onToggle={toggleWorkers}
    />
  );
  const panelToggleControls = (
    <PanelLayoutControls
      terminalAvailable={activeProject !== null}
      terminalOpen={terminalUiState.terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      rightPanelAvailable={activeThreadRef !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {viewerControl}
      {workerEngineControl}
      {!shouldUseRightPanelSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const rightPanelContent = activeThreadRef ? (
    activeRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={activeRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
          onSendAnnotation={(annotation, image) => {
            void onSend(undefined, { annotation, image });
          }}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        threadRef={activeThreadRef}
        surface={activeRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : activeRightPanelSurface?.kind === "diff" ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${activeThreadKey}:${diffPanelGitStatusResolutionKey}`}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          initialGitScope={initialDiffPanelGitScope}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "agents" ? (
      <AgentsPanel
        key={activeThreadKey}
        model={agentPanelModel}
        environmentId={activeThreadRef?.environmentId ?? null}
        threadId={activeThreadRef?.threadId ?? null}
      >
        <ThreadTurnViewer
          historyState={isLocalDraftThread ? "draft" : !serverThread ? "loading" : "saved"}
          thread={activeThread}
          workLog={workLogEntries}
          onOpenTurnDiff={onOpenTurnDiff}
          checkpoints={turnDiffSummaries}
          blocks={orchestraBlocks}
          nextModel={composerModelSelection}
          onEditTeam={focusTeamEditor}
          pendingApprovals={pendingApprovals}
          responseStyleProfile={responseStyleProfile}
        />
      </AgentsPanel>
    ) : activeRightPanelSurface?.kind === "workers" ? (
      <WorkerEnginePanel
        key={`workers:${activeThreadKey}`}
        mode="panel"
        environmentId={activeThreadRef.environmentId}
        threadId={activeThreadRef.threadId}
        defaultCwd={activeWorkspaceRoot ?? activeProject?.workspaceRoot ?? null}
      />
    ) : activeRightPanelSurface?.kind === "files" || activeRightPanelSurface?.kind === "file" ? (
      (() => {
        const filePanelCwd = activeWorkspaceRoot ?? activeProject?.workspaceRoot ?? null;
        if (!activeProject || !filePanelCwd) {
          return (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              프로젝트 폴더를 확인하는 중이거나 연결된 작업 공간이 없습니다.
            </div>
          );
        }
        return (
          <Suspense
            fallback={
              <div
                role="status"
                className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-muted-foreground"
              >
                파일 탐색기를 불러오는 중…
              </div>
            }
          >
            <FilePreviewPanel
              key={`${activeProject.environmentId}:${filePanelCwd}`}
              environmentId={activeProject.environmentId}
              cwd={filePanelCwd}
              projectName={activeProject.title}
              threadRef={activeThreadRef}
              composerDraftTarget={composerDraftTarget}
              keybindings={keybindings}
              availableEditors={availableEditors}
              relativePath={
                activeRightPanelSurface.kind === "file"
                  ? activeRightPanelSurface.relativePath
                  : null
              }
              revealLine={activeFileSurface?.revealLine ?? null}
              revealRequestId={activeFileSurface?.revealRequestId ?? 0}
              onOpenFile={openFileSurface}
              onPendingChange={handleFilePendingChange}
            />
          </Suspense>
        );
      })()
    ) : null
  ) : null;

  return (
    <ComposerFileDropZone onFiles={(files) => composerRef.current?.addFiles(files) ?? false}>
      <ActivitySummaryProvider
        environmentId={activeThread.environmentId}
        threadId={isServerThread ? activeThread.id : null}
        activities={threadActivities}
        checkpoints={turnDiffSummaries}
        onOpenTurnDiff={onOpenTurnDiff}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
            rightPanelMaximized ? "w-0 flex-none" : "flex-1",
          )}
          data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
        >
          {/* Top bar */}
          <header
            data-chat-header
            className={cn(
              "@container/chat-topbar gap-1.5 overflow-hidden bg-background transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:gap-2",
              isElectron
                ? cn(
                    "workspace-topbar drag-region relative px-3 sm:px-5",
                    reserveTitleBarControlInset &&
                      !inlineRightPanelOwnsTitleBar &&
                      "wco:pr-[var(--workspace-native-controls-inset)]",
                  )
                : "workspace-topbar pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <ChatHeader
              activeThreadEnvironmentId={activeThread.environmentId}
              activeThreadId={activeThread.id}
              {...(routeKind === "draft" && draftId ? { draftId } : {})}
              activeThreadTitle={activeThread.title}
              isServerThread={isServerThread}
              changeRequestState={activeThreadPr?.state ?? null}
              activeProjectName={activeProject?.title}
              activeProjectCwd={activeProject?.workspaceRoot ?? null}
              openInCwd={gitCwd}
              activeProjectScripts={activeProject?.scripts}
              preferredScriptId={
                activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
              }
              keybindings={keybindings}
              availableEditors={availableEditors}
              viewerControl={rightPanelOpen ? null : viewerControl}
              workerEngineControl={rightPanelOpen ? null : workerEngineControl}
              gitCwd={gitCwd}
              onNewThreadInProject={handleNewThreadInActiveProject}
              onRunProjectScript={runProjectScript}
              onAddProjectScript={saveProjectScript}
              onUpdateProjectScript={updateProjectScript}
              onDeleteProjectScript={deleteProjectScript}
              backgroundTasks={activeBackgroundTasks}
              onStopBackgroundWork={() => void handleStopBackgroundWork()}
              isStoppingBackgroundWork={isStoppingBackgroundWork}
            />
            <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border/60" />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-7 max-w-[240px] shrink-0 gap-1 px-2 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
              aria-label="모델 설정"
              aria-expanded={modelSettingsOpen}
              aria-controls={modelSettingsId}
              title={
                responseStyleProfile.personaBadge
                  ? `모델 설정 · ${responseStyleProfile.personaBadge} (${responseStyleProfile.scopeLabel})`
                  : "하위 모델과 답변 스타일 (전역 · 이 방)"
              }
              onClick={toggleModelSettings}
            >
              <SlidersHorizontalIcon aria-hidden className="size-3.5 shrink-0" />
              <ResponseStylePill profile={responseStyleProfile} />
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  "size-3 shrink-0 transition-transform",
                  modelSettingsOpen && "rotate-180",
                )}
              />
            </Button>
            {isForeground &&
              isLocalDraftThread &&
              draftId &&
              !draftThread?.promotedTo &&
              hasLocalDraftContent && (
                <DraftDiscardButton
                  draftId={draftId}
                  threadRef={routeThreadRef}
                  disabled={isSendBusy || draftWorkflowStarts > 0}
                  isSending={() => sendInFlightRef.current}
                />
              )}
            {!rightPanelOpen && panelToggleControls}
          </header>
          <div
            id={modelSettingsId}
            hidden={!modelSettingsOpen}
            className={cn(
              "shrink-0 overflow-y-auto",
              terminalUiState.terminalOpen
                ? "max-h-[min(28dvh,220px)]"
                : "max-h-[min(45dvh,calc(100dvh-380px))]",
            )}
          >
            {hasOpenedModelSettings && (
              <RoomModelSettings
                key={activeThread.environmentId}
                environmentId={activeThread.environmentId}
                addModelRef={teamAddModelRef}
                room={
                  isServerThread || isLocalDraftThread
                    ? {
                        threadId: activeThread.id,
                        modelSelection: composerModelSelection ?? activeThread.modelSelection,
                        draftId: isLocalDraftThread ? localDraftId : null,
                      }
                    : undefined
                }
              />
            )}
          </div>

          {!hideCharacter && (isServerThread || isLocalDraftThread) ? (
            <div
              key={`character:${activeThread.environmentId}:${activeThread.id}`}
              className="shrink-0"
            >
              <ThreadCharacter
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                isWorking={isWorking}
                {...(desktopAssistantCharacter !== undefined
                  ? { characterOverride: desktopAssistantCharacter }
                  : {})}
              />
            </div>
          ) : null}

          <ThreadErrorBanner
            error={threadError}
            onDismiss={dismissThreadError}
            onNewThread={handleNewThreadInActiveProject}
          />
          {isServerThread &&
          activeProject &&
          desktopAssistantCharacter === undefined &&
          !dedicatedRoom ? (
            <>
              <ThreadCouncilDock
                environmentId={activeThread.environmentId}
                projectId={activeProject.id}
                threadId={activeThread.id}
                chairLabel={
                  (composerModelSelection ?? activeThread.modelSelection)?.model ?? "활성 모델"
                }
                providerStatuses={providerStatuses as ServerProvider[]}
                runtimeMode={runtimeMode}
                interactionMode={interactionMode}
              />
              <ThreadMissionDock
                environmentId={activeThread.environmentId}
                projectId={activeProject.id}
                threadId={activeThread.id}
                providerStatuses={providerStatuses as ServerProvider[]}
              />
            </>
          ) : null}
          {/* Main content area with optional plan sidebar */}
          <div className="flex min-h-[320px] min-w-0 flex-1">
            {/* Chat column */}
            <div
              data-chat-stream-viewport
              className="relative flex min-h-[320px] min-w-0 flex-1 flex-col"
            >
              {upgradeRoomProgress && (
                <UpgradeRoomProgressCard
                  progress={upgradeRoomProgress}
                  waiting={
                    activePendingUserInput
                      ? "질문 답변 대기"
                      : activePendingApproval
                        ? "승인 대기"
                        : null
                  }
                />
              )}
              {/* Provider status overlays the timeline without changing its content height. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
                <ProviderStatusBanner
                  status={visibleProviderStatus}
                  onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
                />
                <UpgradeRoomOfflineWorkCard
                  threadId={activeThread.id}
                  activities={threadActivities}
                  enabled={serverConfig?.settings.upgradeRoomDowntimeSummary ?? false}
                />
              </div>
              {/* Messages Wrapper */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                {/* Messages — LegendList handles virtualization and scrolling internally */}
                <MessagesTimeline
                  orchestraBlocks={orchestraBlocks}
                  orchestraRuns={meetingRunsQuery.data?.runs}
                  backgroundTasks={activeBackgroundTasks}
                  hasActiveBackgroundWork={
                    activeBackgroundTasks.some((task) => task.state !== "COMPLETED") ||
                    activeBackgroundLiveness !== null ||
                    activeBackgroundMonitorTitles.length > 0
                  }
                  agentPanelModel={agentPanelModel}
                  onOpenAgents={addAgentsSurface}
                  key={activeThread.id}
                  isWorking={isWorking}
                  workingStepLabel={workingStepLabel}
                  activeTurnInProgress={isWorking || !latestTurnSettled}
                  activeTurnStartedAt={activeWorkStartedAt}
                  listRef={legendListRef}
                  timelineEntries={timelineEntries}
                  latestTurn={activeLatestTurn}
                  runningTurnId={
                    activeThread.session?.status === "running"
                      ? activeThread.session.activeTurnId
                      : null
                  }
                  turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                  activeThreadEnvironmentId={activeThread.environmentId}
                  routeThreadKey={routeThreadKey}
                  onOpenTurnDiff={onOpenTurnDiff}
                  revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                  onRevertUserMessage={onRevertUserMessage}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImage}
                  markdownCwd={gitCwd ?? undefined}
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={activeWorkspaceRoot}
                  skills={timelineSkills}
                  anchorMessageId={timelineAnchorMessageId}
                  onAnchorReady={onTimelineAnchorReady}
                  contentInsetEndAdjustment={composerOverlayHeight}
                  liveFollowEnabled={timelineLiveFollowEnabled}
                  onIsAtEndChange={onIsAtEndChange}
                  onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                  hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                  topFadeEnabled={!hasTimelineTopBanner}
                  loadEarlier={loadEarlierTurns}
                  tailFirstRevealKey={`${activeThread.id}:${foregroundRevealNonce}`}
                  responseStyleProfile={responseStyleProfile}
                />

                {/* scroll to end pill — shown when user has scrolled away from the live edge */}
                {showScrollToBottom && (
                  <div
                    className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                    style={{ bottom: composerOverlayHeight + 4 }}
                  >
                    <button
                      type="button"
                      aria-label="맨 아래로 이동"
                      title="맨 아래로 이동"
                      onClick={() => scrollToEnd(true)}
                      className="chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                    >
                      <ChevronDownIcon className="size-3.5" />
                      맨 아래로 이동
                    </button>
                  </div>
                )}
              </div>

              {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
              <div
                ref={setComposerOverlayElement}
                data-chat-composer-overlay="true"
                data-composer-underlay-scrim={isDraftHeroState ? "false" : "true"}
                className={
                  isDraftHeroState
                    ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                    : "pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background from-70% via-background/95 via-85% to-transparent pt-3 sm:pt-4"
                }
              >
                <div
                  ref={attachDraftHeroTransitionGroupRef}
                  className="chat-composer-horizontal-inset w-full"
                >
                  <div className="pointer-events-auto relative z-10">
                    {isDraftHeroState ? (
                      <div className="absolute inset-x-0 bottom-full z-0">
                        <div
                          className="pb-8"
                          style={
                            forceExpandedMobileComposer
                              ? {
                                  viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                                }
                              : undefined
                          }
                        >
                          <DraftHeroHeadline
                            activeProjectRef={activeProjectRef}
                            activeProjectTitle={activeProject?.title ?? null}
                          />
                        </div>
                        <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                      </div>
                    ) : (
                      <>
                        {showBackgroundLivePanel ? (
                          <BackgroundActivityLivePanel
                            tasks={activeBackgroundTasks}
                            liveness={activeBackgroundLiveness}
                            workingStepLabel={workingStepLabel}
                            monitorTitles={activeBackgroundMonitorTitles}
                            latestActivityLabel={latestBackgroundActivityLabel}
                            isWorking={isWorking}
                            onStopBackgroundWork={() => void handleStopBackgroundWork()}
                            isStoppingBackgroundWork={isStoppingBackgroundWork}
                          />
                        ) : null}
                        <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                      </>
                    )}
                    {threadSyncPhase && !activeEnvironmentUnavailable ? (
                      <ThreadSyncStatusPill phase={threadSyncPhase} />
                    ) : null}
                    <div
                      className="relative"
                      style={
                        forceExpandedMobileComposer
                          ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                          : undefined
                      }
                    >
                      <div
                        className={cn(
                          "chat-composer-glass-shell relative mx-auto w-full",
                          showComposerContextStrip && "chat-composer-glass-shell-with-context",
                        )}
                      >
                        <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                          <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                            {pendingTaskConditions?.threadId === activeThread.id ? (
                              <TaskConditionsDialog
                                draft={pendingTaskConditions.draft}
                                {...(pendingTaskConditions.workOnlyReason
                                  ? { workOnlyReason: pendingTaskConditions.workOnlyReason }
                                  : {})}
                                onChange={(draft) =>
                                  setPendingTaskConditions((current) =>
                                    current ? { ...current, draft } : null,
                                  )
                                }
                                onCancel={() => setPendingTaskConditions(null)}
                                onApprove={(conditions) => {
                                  const review = pendingTaskConditions;
                                  setPendingTaskConditions(null);
                                  void onSend(undefined, review.directAnnotation, {
                                    contextKey: review.contextKey,
                                    conditions,
                                  });
                                }}
                              />
                            ) : null}
                            <ChatComposer
                              responseStyleVariant={responseStyleProfile.variant}
                              onViewerModelChange={handleComposerModelChange}
                              assistantModelLocked={
                                desktopAssistantCharacter !== undefined || !!dedicatedRoom
                              }
                              {...(dedicatedRoom ? { roomModelPicker: dedicatedRoom.picker } : {})}
                              {...(dedicatedRoom?.modelSelection
                                ? { assistantModelSelection: dedicatedRoom.modelSelection }
                                : desktopAssistantModelSelection
                                  ? { assistantModelSelection: desktopAssistantModelSelection }
                                  : {})}
                              composerRef={composerRef}
                              composerDraftTarget={composerDraftTarget}
                              workflowProject={activeProject}
                              {...(isLocalDraftThread
                                ? { onDraftWorkflowStarting: trackDraftWorkflowStart }
                                : {})}
                              getWorkflowBootstrap={(modelSelection, title) => {
                                if (!activeProject) return undefined;
                                const prepareWorktree =
                                  activeThread.messages.length === 0 &&
                                  sendEnvMode === "worktree" &&
                                  !activeThread.worktreePath;
                                if (!isLocalDraftThread && !prepareWorktree) return undefined;
                                return {
                                  ...draftCreation(
                                    truncate(title),
                                    modelSelection,
                                    workflowInteractionMode,
                                  ),
                                  ...(prepareWorktree && activeThreadBranch
                                    ? {
                                        prepareWorktree: {
                                          projectCwd: activeProject.workspaceRoot,
                                          baseBranch: activeThreadBranch,
                                          branch: buildTemporaryWorktreeBranchName(randomHex),
                                          startFromOrigin,
                                        },
                                        runSetupScript: true,
                                      }
                                    : {}),
                                };
                              }}
                              {...(activeThread.messages.length === 0 &&
                              sendEnvMode === "worktree" &&
                              !activeThread.worktreePath &&
                              !activeThreadBranch
                                ? {
                                    workflowBootstrapUnavailableReason:
                                      "작업 트리의 기준 브랜치를 선택하세요.",
                                  }
                                : {})}
                              environmentId={environmentId}
                              development={developmentComposerContext}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadRef}
                              draftId={draftId}
                              activeThreadId={activeThreadId}
                              activeThreadEnvironmentId={activeThread?.environmentId}
                              activeThread={activeThread}
                              isServerThread={isServerThread}
                              isLocalDraftThread={isLocalDraftThread}
                              forceExpandedOnMobile={
                                forceExpandedMobileComposer && isDraftHeroState
                              }
                              projectSelectionRequired={
                                isLocalDraftThread && activeProject === null
                              }
                              phase={
                                developmentEnabled && developmentTarget.workspaceId
                                  ? "ready"
                                  : phase
                              }
                              isConnecting={isConnecting}
                              isSendBusy={isSendBusy}
                              integratedWorkActive={liveMeetingRun !== undefined}
                              sendDisabledReason={
                                dedicatedRoom?.sendDisabledReason ??
                                (threadDetailLoading ? "메시지 불러오는 중" : null)
                              }
                              isPreparingWorktree={isPreparingWorktree}
                              environmentUnavailable={activeEnvironmentUnavailableState}
                              activePendingApproval={activePendingApproval}
                              pendingApprovals={pendingApprovals}
                              pendingUserInputs={pendingUserInputs}
                              activePendingProgress={
                                developmentEnabled && developmentTarget.workspaceId
                                  ? null
                                  : activePendingProgress
                              }
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              respondingRequestIds={respondingRequestIds}
                              orchestraQuestion={
                                orchestraPendingQuestion
                                  ? {
                                      question: orchestraPendingQuestion.question,
                                      options: orchestraPendingQuestion.options,
                                    }
                                  : null
                              }
                              orchestraQuestionAnswering={answeringOrchestraQuestion}
                              onAnswerOrchestraQuestion={handleAnswerOrchestraQuestion}
                              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                              activeProposedPlan={activeProposedPlan}
                              runtimeMode={runtimeMode}
                              interactionMode={interactionMode}
                              workflowInteractionMode={workflowInteractionMode}
                              lockedProvider={null}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              activeProjectDefaultModelSelection={
                                activeProject?.defaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeThreadActivities={activeThread?.activities}
                              resolvedTheme={resolvedTheme}
                              settings={settings}
                              keybindings={keybindings}
                              terminalOpen={Boolean(terminalUiState.terminalOpen)}
                              gitCwd={gitCwd}
                              promptRef={promptRef}
                              composerImagesRef={composerImagesRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              composerElementContextsRef={composerElementContextsRef}
                              onSend={onSend}
                              onInterrupt={onInterrupt}
                              onImplementPlanInNewThread={onImplementPlanInNewThread}
                              onRespondToApproval={onRespondToApproval}
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOption
                              }
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestion
                              }
                              onAddPendingQuestionImages={onAddPendingQuestionImages}
                              onRemovePendingQuestionImage={onRemovePendingQuestionImage}
                              onChangeActivePendingUserInputCustomAnswer={
                                onChangeActivePendingUserInputCustomAnswer
                              }
                              onProviderModelSelect={
                                dedicatedRoom?.picker.onSelect ?? onProviderModelSelect
                              }
                              toggleInteractionMode={toggleInteractionMode}
                              handleRuntimeModeChange={handleRuntimeModeChange}
                              handleInteractionModeChange={handleInteractionModeChange}
                              focusComposer={focusComposer}
                              scheduleComposerFocus={scheduleComposerFocus}
                              setThreadError={setThreadError}
                              onExpandImage={onExpandTimelineImage}
                            />
                          </div>
                        </div>
                        <div className="min-h-0">
                          <div
                            data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                            className="relative z-0"
                          >
                            {showComposerContextStrip && (
                              <div className="pointer-events-auto">
                                <BranchToolbar
                                  environmentId={activeThread.environmentId}
                                  threadId={activeThread.id}
                                  showGitControls={isGitRepo}
                                  {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                  onEnvModeChange={onEnvModeChange}
                                  startFromOrigin={startFromOrigin}
                                  onStartFromOriginChange={onStartFromOriginChange}
                                  {...(canOverrideServerThreadEnvMode
                                    ? { effectiveEnvModeOverride: envMode }
                                    : {})}
                                  {...(canOverrideServerThreadEnvMode
                                    ? {
                                        activeThreadBranchOverride: activeThreadBranch,
                                        onActiveThreadBranchOverrideChange:
                                          setPendingServerThreadBranch,
                                      }
                                    : {})}
                                  envLocked={envLocked}
                                  onComposerFocusRequest={scheduleComposerFocus}
                                  {...(canCheckoutPullRequestIntoThread
                                    ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                    : {})}
                                  {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                  availableEnvironments={logicalProjectEnvironments}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div
                        aria-hidden
                        className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {activeThreadRef && activePreviewMiniPlayer ? (
                <ThreadPreviewMiniPlayer
                  key={`${activeThreadKey}:${activePreviewMiniPlayer.tabId}`}
                  threadRef={activeThreadRef}
                  tabId={activePreviewMiniPlayer.tabId}
                  bottomInset={isDraftHeroState ? 0 : composerOverlayHeight}
                />
              ) : null}

              <AlertDialog
                open={branchRestoreConfirmOpen}
                onOpenChange={setBranchRestoreConfirmOpen}
              >
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      <code className="font-medium">
                        {localCheckoutBranchMismatch?.threadBranch ?? ""}
                      </code>{" "}
                      브랜치로 전환할까요?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      커밋하지 않은 변경 사항이 있습니다. 다른 브랜치로 함께 이동하며, 충돌하면
                      전환이 중단됩니다.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogClose render={<Button variant="outline" />}>취소</AlertDialogClose>
                    <Button
                      variant="default"
                      onClick={() => {
                        setBranchRestoreConfirmOpen(false);
                        void handleSwitchCheckoutToThread();
                      }}
                    >
                      브랜치 전환
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>

              {pullRequestDialogState ? (
                <PullRequestThreadDialog
                  key={pullRequestDialogState.key}
                  open
                  environmentId={activeThread.environmentId}
                  threadId={activeThread.id}
                  cwd={activeProject?.workspaceRoot ?? null}
                  initialReference={pullRequestDialogState.initialReference}
                  onOpenChange={(open) => {
                    if (!open) {
                      closePullRequestDialog();
                    }
                  }}
                  onPrepared={handlePreparedPullRequestThread}
                />
              ) : null}
            </div>
            {/* end chat column */}
          </div>
          {/* end horizontal flex container */}

          <div
            data-terminal-drawer-clamp={terminalUiState.terminalOpen ? "true" : "false"}
            className={cn(
              "shrink-0 overflow-hidden",
              terminalUiState.terminalOpen &&
                (modelSettingsOpen
                  ? "max-h-[min(42dvh,calc(100dvh-420px))]"
                  : "max-h-[calc(100dvh-372px)]"),
            )}
          >
            {mountedTerminalThreadRefs.map(
              ({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
                <PersistentThreadTerminalDrawer
                  key={mountedThreadKey}
                  threadRef={mountedThreadRef}
                  threadId={mountedThreadRef.threadId}
                  visible={mountedThreadKey === activeThreadKey && terminalUiState.terminalOpen}
                  launchContext={
                    mountedThreadKey === activeThreadKey
                      ? (activeTerminalLaunchContext ?? null)
                      : null
                  }
                  focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
                  splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
                  splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
                  newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                  closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
                  keybindings={keybindings}
                  onAddTerminalContext={addTerminalContextToDraft}
                />
              ),
            )}
          </div>
        </div>

        {!shouldUseRightPanelSheet && rightPanelOpen && activeThreadRef ? (
          <RightPanelTabs
            mode="inline"
            maximized={rightPanelMaximized}
            layoutControls={panelLayoutControls}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddAgents={addAgentsSurface}
            onAddWorkers={addWorkersSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
          >
            {rightPanelContent}
          </RightPanelTabs>
        ) : null}
        {shouldUseRightPanelSheet && rightPanelOpen && activeThreadRef ? (
          <RightPanelSheet open onClose={closePreviewPanel}>
            <RightPanelTabs
              mode="sheet"
              layoutControls={panelLayoutControls}
              surfaces={rightPanelState.surfaces}
              activeSurfaceId={activeRightPanelSurface?.id ?? null}
              pendingSurfaceIds={pendingFileSurfaceIds}
              previewSessions={activePreviewState.sessions}
              terminalLabelsById={activeTerminalLabelsById}
              onActivate={activateRightPanelSurface}
              onCloseSurface={closeRightPanelSurface}
              onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
              onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
              onCloseAllSurfaces={closeAllRightPanelSurfaces}
              onCopyFilePath={copyRightPanelFilePath}
              onAddBrowser={createBrowserSurface}
              onAddTerminal={addTerminalSurface}
              onAddDiff={addDiffSurface}
              onAddFiles={addFilesSurface}
              onAddAgents={addAgentsSurface}
              onAddWorkers={addWorkersSurface}
              browserAvailable={isPreviewSupportedInRuntime()}
              diffAvailable={isServerThread && isGitRepo}
              filesAvailable={activeProject !== null}
            >
              {rightPanelContent}
            </RightPanelTabs>
          </RightPanelSheet>
        ) : null}

        {expandedImage && (
          <ExpandedImageDialog
            key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
            preview={expandedImage}
            onClose={closeExpandedImage}
          />
        )}
      </ActivitySummaryProvider>
    </ComposerFileDropZone>
  );
}

export default function ChatView(props: ChatViewProps) {
  const isAssistant = props.desktopAssistantCharacter !== undefined;
  const assistantModel = props.desktopAssistantModelSelection;
  if (isAssistant && !assistantModel) {
    return <p className="p-4 text-sm">비서 AI 설정을 확인하고 있습니다.</p>;
  }
  return (
    <DiffWorkerPoolProvider>
      <ChatViewContent {...props} />
    </DiffWorkerPoolProvider>
  );
}
