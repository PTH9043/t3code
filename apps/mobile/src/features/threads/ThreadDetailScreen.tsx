import { isRecoverableUserInputRequestId } from "@t3tools/contracts";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  describeUpgradeRoomProgress,
  type UpgradeRoomProgress,
} from "@t3tools/client-runtime/state/thread-tool-activity";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import type {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ThreadId,
  WorkspaceMonitoringPlan,
  WorkspaceMeetingQuestion,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, View, type GestureResponderEvent } from "react-native";
import { KeyboardController, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import { AppText as Text } from "../../components/AppText";
import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { selectThreadOrchestraOption } from "../../state/thread-orchestra";
import { awaitComposerDraftsLoaded } from "../../state/use-composer-drafts";
import type { MobileOrchestraConfig } from "../../state/thread-orchestra-config";
import { MobileOrchestraSettings } from "./MobileOrchestraSettings";
import { CHAT_CONTENT_MAX_WIDTH, type LayoutVariant } from "../../lib/layout";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { MonitoringPlanCard } from "./MonitoringPlanCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import { TokenUsageButton } from "./TokenUsageButton";
import { ThreadResponseStyleSettings } from "./ThreadResponseStyleSettings";
import { ThreadTeamViewer } from "./ThreadTeamViewer";
import { ThreadBackgroundWatch } from "./ThreadBackgroundWatch";
import type { ThreadContentPresentation } from "./threadContentPresentation";

export interface ThreadDetailScreenProps {
  readonly selectedThread: OrchestrationThreadShell;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly activeWorkStartedAt: string | null;
  readonly upgradeRoomProgress?: UpgradeRoomProgress | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | string[]> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly pickingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  /** Message sync status for the selected thread (drives the composer status pill). */
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  /** Non-null when older turns exist beyond the loaded window. */
  readonly loadEarlier?: { readonly loading: boolean; readonly onLoadEarlier: () => void } | null;
  readonly activeThreadBusy: boolean;
  readonly orchestraActive?: boolean;
  readonly orchestraQuestion?: WorkspaceMeetingQuestion | null;
  readonly orchestraError?: string | null;
  readonly hasOrchestraAttempt?: boolean;
  readonly hasOrchestraStartAttempt?: boolean;
  readonly orchestraConfig: MobileOrchestraConfig;
  readonly onChangeOrchestraConfig: (config: MobileOrchestraConfig) => void;
  readonly onRetryOrchestraStart: () => Promise<void>;
  readonly onRestoreOrchestraStart: () => Promise<void>;
  readonly orchestraAttemptBusy?: boolean;
  readonly onRetryOrchestraAttempt?: () => Promise<void>;
  readonly onRestoreOrchestraAttempt?: () => Promise<void>;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly failedQueuedMessage?: QueuedThreadMessage | undefined;
  readonly onRetryFailedMessage?: (message: QueuedThreadMessage) => Promise<void>;
  readonly onRestoreFailedMessage?: (message: QueuedThreadMessage) => Promise<void>;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  /** Set when this thread is its project's monitoring thread and a plan awaits approval. */
  readonly proposedMonitoringPlan: WorkspaceMonitoringPlan | null;
  readonly approvingMonitoringPlan: boolean;
  readonly onApproveMonitoringPlan: () => Promise<unknown>;
  readonly onSelectUserInputOption: (
    requestId: ApprovalRequestId,
    questionId: string,
    label: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly onPickUserInputImages: (
    requestId: ApprovalRequestId,
    questionId: string,
  ) => Promise<void>;
  readonly onRemoveUserInputImage: (
    requestId: ApprovalRequestId,
    questionId: string,
    imageId: string,
  ) => void;
  readonly showContent?: boolean;
}

function UpgradeRoomProgressLine({
  progress,
  waiting,
}: {
  readonly progress: UpgradeRoomProgress;
  readonly waiting: string | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View accessibilityLabel="업그레이드 방 작업 상황" className="border-b border-border px-4 py-2">
      <Text className="text-xs">
        {describeUpgradeRoomProgress(progress, now, waiting)}
        {progress.recordedAt
          ? ` · ${new Date(progress.recordedAt).toLocaleTimeString("ko-KR", { hour12: false })}`
          : ""}
      </Text>
      {progress.label && (
        <Text className="text-xs text-muted-foreground">
          {progress.label}
          {progress.completedTools > 0 ? ` · 도구 ${progress.completedTools}회 종료` : ""}
        </Text>
      )}
      {progress.plan && <Text className="text-xs">{progress.plan}</Text>}
    </View>
  );
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: ThreadId, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const composerOverlayRef = useRef<View>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledAnchorMessageIdRef = useRef<MessageId | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [teamSettingsEnvironment, setTeamSettingsEnvironment] = useState<EnvironmentId | null>(
    null,
  );
  const [orchestraSettingsOpen, setOrchestraSettingsOpen] = useState(false);
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const openOrchestraSettings = useCallback(async () => {
    const threadKey = selectedThreadKey;
    if (!(await awaitComposerDraftsLoaded())) {
      Alert.alert("저장된 대화 설정을 읽지 못했습니다.");
      return;
    }
    if (selectedThreadKeyRef.current === threadKey) setOrchestraSettingsOpen(true);
  }, [selectedThreadKey]);

  useEffect(() => setOrchestraSettingsOpen(false), [selectedThreadKey]);
  const composerBottomInset = composerExpanded ? 0 : Math.max(insets.bottom, 12);
  const contentPresentationKind = props.contentPresentation.kind;
  // The raw sync status enters "synchronizing" on every full fetch, cached or
  // not. Whether messages are already on screen decides the pill label: no
  // data yet → "Loading messages", cached data reconciling → "Syncing".
  const threadSyncPhase = (() => {
    switch (props.threadSyncStatus) {
      case "empty":
      case "cached":
      case "synchronizing":
        if (contentPresentationKind === "ready") {
          return "syncing" as const;
        }
        return contentPresentationKind === "loading" ? ("loading" as const) : null;
      default:
        return null;
    }
  })();
  const selectedThreadFeed = props.selectedThreadFeed;
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  const estimatedOverlayHeight = composerOverlapHeight;
  // The overlay's measured height includes the home-indicator inset (the
  // composer pads it), but contentInsetAdjustmentBehavior="automatic" makes
  // UIKit add the safe-area bottom to the content inset AGAIN — leaving a
  // dead strip between the resting content and the composer. Report the
  // overlay height minus the safe area; UIKit adds it back, and ThreadFeed
  // hands LegendList the same delta via contentInsetEndStaticAdjustment so
  // its end-scroll math matches the real resting position.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
    -nativeInsetOvercount,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth = isSplitLayout ? CHAT_CONTENT_MAX_WIDTH : undefined;
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const selectedProvider = useMemo(
    () =>
      props.serverConfig?.providers.find(
        (provider) => provider.instanceId === selectedInstanceId,
      ) ?? null,
    [props.serverConfig, selectedInstanceId],
  );
  const selectedProviderSkills = useMemo(() => selectedProvider?.skills ?? [], [selectedProvider]);

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
  }, [selectedThreadKey]);

  useEffect(() => {
    setAnchorMessageId(null);
    lastScrolledAnchorMessageIdRef.current = null;
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      anchorMessageId === null ||
      lastScrolledAnchorMessageIdRef.current === anchorMessageId ||
      contentPresentationKind !== "ready" ||
      !selectedThreadFeed.some((entry) => entry.type === "message" && entry.id === anchorMessageId)
    ) {
      return;
    }

    const targetThreadKey = selectedThreadKey;
    const frame = requestAnimationFrame(() => {
      if (selectedThreadKeyRef.current !== targetThreadKey) {
        return;
      }
      lastScrolledAnchorMessageIdRef.current = anchorMessageId;
      // Wait for the keyboard dismissal (started by blur() on send) to finish
      // before scrolling: scrollMessageToEnd freezes keyboard-driven inset
      // updates while it runs, and a close event swallowed by that freeze
      // leaves the keyboard padding permanently applied — overshooting the
      // anchor and leaving a phantom bottom inset once the reply streams in.
      void KeyboardController.dismiss()
        .then(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledAnchorMessageIdRef.current !== anchorMessageId
          ) {
            return;
          }
          return scrollMessageToEnd({ animated: true, closeKeyboard: false });
        })
        .catch(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledAnchorMessageIdRef.current !== anchorMessageId
          ) {
            return;
          }
          lastScrolledAnchorMessageIdRef.current = null;
          freeze.set(false);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    anchorMessageId,
    freeze,
    contentPresentationKind,
    selectedThreadFeed,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  const handleSendMessage = useCallback(async () => {
    const targetThreadKey = selectedThreadKey;
    const messageId = await props.onSendMessage();
    if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
      return messageId;
    }

    setAnchorMessageId(messageId);
    composerEditorRef.current?.blur();
    return messageId;
  }, [props.onSendMessage, selectedThreadKey]);

  const collapseComposer = useCallback(() => {
    composerEditorRef.current?.blur();
  }, []);

  const handleFeedTouchStart = useCallback((event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handleFeedTouchMove = useCallback((event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  }, []);

  const handleFeedTouchEnd = useCallback(() => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  }, [collapseComposer]);

  const handleFeedTouchCancel = useCallback(() => {
    feedTouchStartRef.current = null;
  }, []);

  return (
    <View className="flex-1">
      {showContent ? (
        <View
          className="flex-1"
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          {props.upgradeRoomProgress && (
            <UpgradeRoomProgressLine
              progress={props.upgradeRoomProgress}
              waiting={
                props.activePendingUserInput
                  ? "질문 답변 대기"
                  : props.activePendingApproval
                    ? "승인 대기"
                    : null
              }
            />
          )}
          <ThreadFeed
            key={props.selectedThread.id}
            environmentId={props.environmentId}
            threadId={props.selectedThread.id}
            workspaceRoot={props.threadCwd}
            feed={props.selectedThreadFeed}
            contentPresentation={props.contentPresentation}
            agentLabel={agentLabel}
            latestTurn={props.selectedThread.latestTurn}
            activeWorkStartedAt={props.activeWorkStartedAt}
            listRef={listRef}
            freeze={freeze}
            anchorMessageId={anchorMessageId}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            contentTopInset={0}
            contentBottomInset={estimatedOverlayHeight}
            contentMaxWidth={contentMaxWidth}
            layoutVariant={layoutVariant}
            usesAutomaticContentInsets={props.usesAutomaticContentInsets}
            onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
            skills={selectedProviderSkills}
            loadEarlier={props.loadEarlier ?? null}
          />
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      {showContent ? (
        <KeyboardStickyView
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          {/* No paddingTop here: the overlay's measured height becomes the
              list's bottom inset, so any padding above the pill/composer
              pushes the resting content floor up by the same amount. */}
          <View ref={composerOverlayRef} onLayout={onComposerLayout} className="w-full">
            <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
              {props.activePendingApproval ||
              props.activePendingUserInput ||
              props.proposedMonitoringPlan ||
              props.orchestraActive ||
              props.orchestraError ||
              props.hasOrchestraAttempt ||
              props.hasOrchestraStartAttempt ||
              props.orchestraConfig.enabled ? (
                <Animated.View
                  className="shrink-0 gap-3 px-4 pb-3"
                  entering={FadeInDown.duration(220)}
                  exiting={FadeOut.duration(140)}
                >
                  {props.orchestraActive ||
                  props.orchestraError ||
                  props.hasOrchestraAttempt ||
                  props.hasOrchestraStartAttempt ||
                  props.orchestraConfig.enabled ? (
                    <View className="gap-2 rounded-xl border border-border bg-card p-3">
                      <Text className="font-t3-bold text-foreground">
                        {props.orchestraQuestion
                          ? "통합 작업 질문"
                          : props.orchestraActive
                            ? "통합 작업 진행 중"
                            : props.orchestraConfig.enabled && !props.hasOrchestraStartAttempt
                              ? "다음 메시지로 통합 작업 시작"
                              : "통합 작업 전송 확인"}
                      </Text>
                      <Text className="text-sm text-foreground">
                        {props.orchestraQuestion?.question ??
                          (props.orchestraActive
                            ? "입력한 추가 지시는 감독 AI에게 전달됩니다."
                            : props.orchestraConfig.enabled && !props.hasOrchestraStartAttempt
                              ? "작업 목표를 입력하고 보내세요."
                              : "보존된 내용을 확인하고 다시 보낼 수 있습니다.")}
                      </Text>
                      {props.orchestraQuestion?.context ? (
                        <Text className="text-xs text-foreground-muted">
                          {props.orchestraQuestion.context}
                        </Text>
                      ) : null}
                      {props.orchestraError ? (
                        <Text className="text-sm text-red-600">{props.orchestraError}</Text>
                      ) : null}
                      {props.hasOrchestraAttempt ? (
                        <View className="gap-2">
                          <Text className="text-xs text-foreground-muted">
                            이전 전송 확인은 원래 내용과 요청 ID를 사용합니다. 초안으로 복원한 뒤
                            다시 보내면 새 요청이므로 먼저 접수 여부를 확인하세요.
                          </Text>
                          <View className="flex-row flex-wrap gap-2">
                            <Pressable
                              accessibilityRole="button"
                              disabled={props.orchestraAttemptBusy}
                              className="rounded-lg border border-border p-2"
                              onPress={() => void props.onRetryOrchestraAttempt?.()}
                            >
                              <Text className="text-sm text-foreground">이전 전송 확인</Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              disabled={props.orchestraAttemptBusy}
                              className="rounded-lg border border-border p-2"
                              onPress={() => void props.onRestoreOrchestraAttempt?.()}
                            >
                              <Text className="text-sm text-foreground">
                                이전 요청을 초안으로 복원
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      ) : null}
                      {props.hasOrchestraStartAttempt ? (
                        <View className="gap-2">
                          <Text className="text-xs text-foreground-muted">
                            이전 시작 확인은 같은 요청을 사용합니다. 초안으로 복원한 뒤 다시 보내면
                            새 요청이므로 먼저 접수 여부를 확인하세요.
                          </Text>
                          <View className="flex-row flex-wrap gap-2">
                            <Pressable
                              accessibilityRole="button"
                              disabled={props.orchestraAttemptBusy}
                              className="rounded-lg border border-border p-2"
                              onPress={() => void props.onRetryOrchestraStart()}
                            >
                              <Text className="text-sm text-foreground">이전 시작 확인</Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              disabled={props.orchestraAttemptBusy}
                              className="rounded-lg border border-border p-2"
                              onPress={() => void props.onRestoreOrchestraStart()}
                            >
                              <Text className="text-sm text-foreground">
                                시작 요청을 초안으로 복원
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      ) : null}
                      {props.orchestraConfig.enabled && !props.orchestraActive ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void openOrchestraSettings()}
                        >
                          <Text className="text-sm text-foreground">통합 작업 설정 변경</Text>
                        </Pressable>
                      ) : null}
                      {[...new Set(props.orchestraQuestion?.options ?? [])].map((option) => (
                        <Pressable
                          key={option}
                          accessibilityRole="button"
                          className="rounded-lg border border-border p-2"
                          onPress={() =>
                            props.onChangeDraftMessage(
                              selectThreadOrchestraOption(
                                props.draftMessage,
                                props.orchestraQuestion?.options ?? [],
                                option,
                              ),
                            )
                          }
                        >
                          <Text className="text-sm text-foreground">{option}</Text>
                        </Pressable>
                      ))}
                      {props.orchestraQuestion ? (
                        <Text className="text-xs text-foreground-muted">
                          선택하거나 직접 입력한 뒤 답변을 보내세요.
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  {props.proposedMonitoringPlan ? (
                    <MonitoringPlanCard
                      plan={props.proposedMonitoringPlan}
                      approving={props.approvingMonitoringPlan}
                      onApprove={props.onApproveMonitoringPlan}
                    />
                  ) : null}
                  {props.activePendingApproval ? (
                    <PendingApprovalCard
                      approval={props.activePendingApproval}
                      respondingApprovalId={props.respondingApprovalId}
                      onRespond={props.onRespondToApproval}
                    />
                  ) : null}
                  {props.activePendingUserInput ? (
                    <PendingUserInputCard
                      pendingUserInput={props.activePendingUserInput}
                      drafts={props.activePendingUserInputDrafts}
                      answers={props.activePendingUserInputAnswers}
                      respondingUserInputId={props.respondingUserInputId}
                      pickingUserInputId={props.pickingUserInputId}
                      canStop={
                        isRecoverableUserInputRequestId(props.activePendingUserInput.requestId) ||
                        props.selectedThread.session?.status === "running" ||
                        props.selectedThread.session?.status === "starting"
                      }
                      onStop={props.onStopThread}
                      onSelectOption={props.onSelectUserInputOption}
                      onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                      onSubmit={props.onSubmitUserInput}
                      onPickImages={props.onPickUserInputImages}
                      onRemoveImage={props.onRemoveUserInputImage}
                    />
                  ) : null}
                </Animated.View>
              ) : null}
            </View>

            <View className="flex-row flex-wrap items-center justify-between">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="전역 하위 모델 설정"
                className="px-4 py-2"
                onPress={() => setTeamSettingsEnvironment(props.environmentId)}
              >
                <Text className="text-xs text-muted-foreground">전역 하위 모델</Text>
              </Pressable>
              {teamSettingsEnvironment === props.environmentId && (
                <ThreadTeamViewer
                  key={props.environmentId}
                  global
                  environmentId={props.environmentId}
                  serverConfig={props.serverConfig}
                  connected={props.connectionStateLabel === "connected"}
                  onClose={() => setTeamSettingsEnvironment(null)}
                />
              )}
              <ThreadResponseStyleSettings
                key={`response-style:${props.environmentId}`}
                environmentId={props.environmentId}
              />
              <ThreadBackgroundWatch
                key={`background-watch:${selectedThreadKey}`}
                environmentId={props.environmentId}
                threadId={props.selectedThread.id}
                connected={props.connectionStateLabel === "connected"}
              />
              <TokenUsageButton
                key={`token-usage:${selectedThreadKey}`}
                environmentId={props.environmentId}
                threadId={props.selectedThread.id}
                busy={props.activeThreadBusy}
                selectedProvider={selectedProvider}
                providers={props.serverConfig?.providers}
              />
            </View>
            <ThreadComposer
              editorRef={composerEditorRef}
              draftMessage={props.draftMessage}
              draftAttachments={props.draftAttachments}
              placeholder="프로젝트 에이전트에게 요청하거나 명령 실행…"
              contentMaxWidth={contentMaxWidth}
              connectionState={props.connectionStateLabel}
              connectionError={props.connectionError}
              environmentLabel={props.environmentLabel}
              threadSyncPhase={threadSyncPhase}
              selectedThread={props.selectedThread}
              pendingQuestionRequestId={props.activePendingUserInput?.requestId}
              serverConfig={props.serverConfig}
              queueCount={props.selectedThreadQueueCount}
              failedQueuedMessage={props.failedQueuedMessage}
              onRetryFailedMessage={props.onRetryFailedMessage}
              onRestoreFailedMessage={props.onRestoreFailedMessage}
              activeThreadBusy={props.activeThreadBusy}
              orchestraActive={props.orchestraActive}
              orchestraHasQuestion={props.orchestraQuestion != null}
              orchestraConfigured={props.orchestraConfig.enabled}
              onOpenOrchestraSettings={() => void openOrchestraSettings()}
              environmentId={props.environmentId}
              projectCwd={props.projectWorkspaceRoot}
              skillCwd={props.threadCwd}
              bottomInset={composerBottomInset}
              onChangeDraftMessage={props.onChangeDraftMessage}
              onPickDraftImages={props.onPickDraftImages}
              onNativePasteImages={props.onNativePasteImages}
              onRemoveDraftImage={props.onRemoveDraftImage}
              onStopThread={props.onStopThread}
              onSendMessage={handleSendMessage}
              onReconnectEnvironment={props.onReconnectEnvironment}
              onUpdateModelSelection={props.onUpdateThreadModelSelection}
              onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
              onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
              onExpandedChange={setComposerExpanded}
            />
          </View>
        </KeyboardStickyView>
      ) : null}
      <MobileOrchestraSettings
        key={selectedThreadKey}
        visible={orchestraSettingsOpen}
        active={props.orchestraActive === true}
        config={props.orchestraConfig}
        currentModel={props.selectedThread.modelSelection}
        serverConfig={props.serverConfig}
        onChange={props.onChangeOrchestraConfig}
        onClose={() => setOrchestraSettingsOpen(false)}
      />
    </View>
  );
});
