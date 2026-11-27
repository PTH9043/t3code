import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reconcileAutomaticAccountSwitch } from "@t3tools/client-runtime/state/account-auto-switch";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorkspaceRuntimeSnapshot,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
  toUploadChatImageAttachments,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildModelOptions } from "../lib/modelOptions";
import { uuidv4 } from "../lib/uuid";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  awaitComposerDraftsLoaded,
  clearComposerDraftContent,
  clearComposerOrchestraAttempt,
  clearComposerOrchestraStartAttempt,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  finishComposerOrchestraStartAttempt,
  mergeComposerDraftContent,
  orchestraAttemptMatchesContent,
  persistComposerOrchestraAttempt,
  persistComposerOrchestraStartAttempt,
  removeComposerDraftAttachment,
  setComposerDraftText,
  setComposerOrchestraConfig,
  updateComposerDraftSettings,
  useComposerDraft,
  type ComposerOrchestraAttempt,
  type ComposerOrchestraStartAttempt,
} from "./use-composer-drafts";
import {
  setPendingConnectionError,
  useRemoteEnvironmentRuntime,
} from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import {
  enqueueThreadOutboxMessage,
  removeThreadOutboxMessageIfCurrent,
  updateThreadOutboxMessageIfCurrent,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { releaseEditingQueuedMessage, useThreadOutboxMessages } from "./use-thread-outbox";
import { orchestrationEnvironment } from "./orchestration";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "./query";
import { useAtomCommand } from "./use-atom-command";
import { activeThreadOrchestra, prepareThreadOrchestraMessage } from "./thread-orchestra";
import {
  createMobileOrchestraStart,
  DEFAULT_MOBILE_ORCHESTRA_CONFIG,
  type MobileOrchestraConfig,
} from "./thread-orchestra-config";
import { deliverOrchestraStart } from "./thread-orchestra-start-delivery";

const workspaceOperationsRevision = (snapshot: WorkspaceRuntimeSnapshot) =>
  snapshot.operationsUpdatedAt ?? "";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const environmentRuntime = useRemoteEnvironmentRuntime(
    selectedThreadShell?.environmentId ?? null,
  );
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const runsQuery = useEnvironmentQuery(
    selectedThreadShell
      ? orchestrationEnvironment.workspaceCollaborationRuns({
          environmentId: selectedThreadShell.environmentId,
          input: { projectId: selectedThreadShell.projectId },
        })
      : null,
  );
  const operationsRevision = useEnvironmentQuerySelector(
    selectedThreadShell
      ? orchestrationEnvironment.workspaceRuntime({
          environmentId: selectedThreadShell.environmentId,
          input: { projectId: selectedThreadShell.projectId },
        })
      : null,
    workspaceOperationsRevision,
  );
  const answerOrchestra = useAtomCommand(projectEnvironment.answerWorkspaceCollaborationRun, {
    reportFailure: false,
  });
  const interjectOrchestra = useAtomCommand(projectEnvironment.interjectWorkspaceCollaborationRun, {
    reportFailure: false,
  });
  const cancelOrchestra = useAtomCommand(projectEnvironment.cancelWorkspaceCollaborationRun, {
    reportFailure: false,
  });
  const startOrchestra = useAtomCommand(orchestrationEnvironment.startWorkflow, {
    reportFailure: false,
  });
  const lastOperationsRef = useRef<{ project: string; revision: string | null } | null>(null);
  const orchestraSendingRef = useRef(new Set<string>());
  const [orchestraBusyThreads, setOrchestraBusyThreads] = useState<ReadonlySet<string>>(new Set());
  const setOrchestraBusy = useCallback((threadKey: string, busy: boolean) => {
    if (busy) orchestraSendingRef.current.add(threadKey);
    else orchestraSendingRef.current.delete(threadKey);
    setOrchestraBusyThreads(new Set(orchestraSendingRef.current));
  }, []);
  const [orchestraError, setOrchestraError] = useState<{
    threadKey: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!selectedThreadShell || operationsRevision === null) return;
    const project = `${selectedThreadShell.environmentId}:${selectedThreadShell.projectId}`;
    const revision = operationsRevision;
    const previous = lastOperationsRef.current;
    lastOperationsRef.current = { project, revision };
    if (previous?.project === project && previous.revision !== revision) runsQuery.refresh();
  }, [selectedThreadShell, operationsRevision, runsQuery.refresh]);

  const activeOrchestra = selectedThreadShell
    ? activeThreadOrchestra(runsQuery.data?.runs ?? [], selectedThreadShell.id)
    : undefined;

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(
    () => (selectedThreadDetail ? buildThreadFeed(selectedThreadDetail) : []),
    [selectedThreadDetail],
  );

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThreadFailedMessage = selectedThreadQueuedMessages.find(
    (message) => message.deliveryFailure !== undefined,
  );
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const accountSwitchCursor = useRef<{ thread: string; id: string | null } | null>(null);
  useEffect(() => {
    if (!selectedThreadKey || !selectedThreadDetail) return;
    const activity = selectedThreadDetail.activities.findLast(
      (item) => item.kind === "provider.account.auto-switched",
    );
    const cursor = accountSwitchCursor.current;
    if (!cursor || cursor.thread !== selectedThreadKey) {
      accountSwitchCursor.current = { thread: selectedThreadKey, id: activity?.id ?? null };
      return;
    }
    if (!activity || cursor.id === activity.id) return;
    const payload = activity.payload as { nextInstanceId?: unknown } | null;
    if (payload?.nextInstanceId !== selectedThreadDetail.modelSelection?.instanceId) return;
    accountSwitchCursor.current = { thread: selectedThreadKey, id: activity.id };
    const next = reconcileAutomaticAccountSwitch(
      activity,
      selectedThreadDetail.modelSelection,
      getComposerDraftSnapshot(selectedThreadKey).modelSelection,
    );
    if (next) updateComposerDraftSettings(selectedThreadKey, { modelSelection: next });
  }, [selectedThreadKey, selectedThreadDetail]);
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const submitOrchestraStartAttempt = useCallback(
    async (environmentId: EnvironmentId, attempt: ComposerOrchestraStartAttempt) => {
      const { threadKey } = attempt;
      if (orchestraSendingRef.current.has(threadKey)) return;
      setOrchestraBusy(threadKey, true);
      setOrchestraError(null);
      try {
        const delivery = await deliverOrchestraStart({
          attempt,
          persist: persistComposerOrchestraStartAttempt,
          send: (input) => startOrchestra({ environmentId, input }),
        });
        if (delivery.kind === "changed") {
          setOrchestraError({
            threadKey,
            message: "설정이나 초안이 변경되어 시작하지 않았습니다.",
          });
          return;
        }
        const result = delivery.result;
        if (result._tag !== "Success") {
          setOrchestraError({
            threadKey,
            message: "시작 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.",
          });
          runsQuery.refresh();
          return;
        }
        finishComposerOrchestraStartAttempt(threadKey, attempt.input.requestId);
        runsQuery.refresh();
      } catch (error) {
        setOrchestraError({
          threadKey,
          message: error instanceof Error ? error.message : "시작 요청을 저장하지 못했습니다.",
        });
      } finally {
        setOrchestraBusy(threadKey, false);
      }
    },
    [startOrchestra, runsQuery.refresh, setOrchestraBusy],
  );

  const onRetryOrchestraStart = useCallback(async () => {
    if (!selectedThreadShell || !(await awaitComposerDraftsLoaded())) return;
    const key = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const attempt = getComposerDraftSnapshot(key).orchestraStartAttempt;
    if (attempt) await submitOrchestraStartAttempt(selectedThreadShell.environmentId, attempt);
  }, [selectedThreadShell, submitOrchestraStartAttempt]);

  const onRestoreOrchestraStart = useCallback(async () => {
    if (!selectedThreadShell || !(await awaitComposerDraftsLoaded())) return;
    const key = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const attempt = getComposerDraftSnapshot(key).orchestraStartAttempt;
    if (!attempt || orchestraSendingRef.current.has(key)) return;
    setOrchestraBusy(key, true);
    try {
      await mergeComposerDraftContent(key, { text: attempt.originalText, attachments: [] });
      clearComposerOrchestraStartAttempt(key, attempt.input.requestId);
      setOrchestraError(null);
    } catch (error) {
      setOrchestraError({
        threadKey: key,
        message: error instanceof Error ? error.message : "이전 요청을 복원하지 못했습니다.",
      });
    } finally {
      setOrchestraBusy(key, false);
    }
  }, [selectedThreadShell, setOrchestraBusy]);

  const onChangeOrchestraConfig = useCallback(
    (config: MobileOrchestraConfig) => {
      if (!selectedThreadShell) return;
      setComposerOrchestraConfig(
        scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id),
        config,
      );
    },
    [selectedThreadShell],
  );

  const submitOrchestraAttempt = useCallback(
    async (environmentId: EnvironmentId, attempt: ComposerOrchestraAttempt) => {
      const { threadKey, prepared } = attempt;
      if (orchestraSendingRef.current.has(threadKey)) return;
      setOrchestraBusy(threadKey, true);
      setOrchestraError(null);
      try {
        if (!(await persistComposerOrchestraAttempt(threadKey, attempt))) {
          setOrchestraError({
            threadKey,
            message: "작성 내용이나 이전 전송 기록이 변경되어 보내지 않았습니다.",
          });
          return;
        }
        const common = {
          projectId: attempt.projectId,
          runId: attempt.runId,
          commandId: attempt.commandId,
          createdAt: attempt.createdAt,
        };
        const result =
          prepared.kind === "stop"
            ? await cancelOrchestra({ environmentId, input: common })
            : prepared.kind === "answer"
              ? await answerOrchestra({
                  environmentId,
                  input: {
                    ...common,
                    question: prepared.question,
                    questionRef: prepared.questionRef,
                    answer: prepared.text,
                    ...(attempt.originalAttachments.length
                      ? { images: toUploadChatImageAttachments(attempt.originalAttachments) }
                      : {}),
                  },
                })
              : await interjectOrchestra({
                  environmentId,
                  input: { ...common, text: prepared.text },
                });
        if (result._tag !== "Success") {
          setOrchestraError({
            threadKey,
            message:
              "통합 작업에 전달하지 못했거나 결과를 확인하지 못했습니다. 이전 요청과 초안을 보존했습니다.",
          });
          runsQuery.refresh();
          return;
        }
        const current = getComposerDraftSnapshot(threadKey);
        if (current.text === attempt.originalText) setComposerDraftText(threadKey, "");
        for (const image of attempt.originalAttachments) {
          const stillPresent = getComposerDraftSnapshot(threadKey).attachments.find(
            (entry) => entry.id === image.id,
          );
          if (
            stillPresent?.dataUrl === image.dataUrl &&
            stillPresent.name === image.name &&
            stillPresent.mimeType === image.mimeType &&
            stillPresent.sizeBytes === image.sizeBytes
          )
            removeComposerDraftAttachment(threadKey, image.id);
        }
        clearComposerOrchestraAttempt(threadKey, attempt.commandId);
        runsQuery.refresh();
      } catch (error) {
        setOrchestraError({
          threadKey,
          message:
            error instanceof Error ? error.message : "통합 작업의 전송 기록을 저장하지 못했습니다.",
        });
      } finally {
        setOrchestraBusy(threadKey, false);
      }
    },
    [answerOrchestra, cancelOrchestra, interjectOrchestra, runsQuery.refresh, setOrchestraBusy],
  );

  const onRetryOrchestraAttempt = useCallback(async () => {
    if (!selectedThreadShell) return;
    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    if (!(await awaitComposerDraftsLoaded())) {
      setOrchestraError({ threadKey, message: "저장된 전송 기록을 읽지 못했습니다." });
      return;
    }
    const attempt = getComposerDraftSnapshot(threadKey).orchestraAttempt;
    if (attempt) await submitOrchestraAttempt(selectedThreadShell.environmentId, attempt);
  }, [selectedThreadShell, submitOrchestraAttempt]);

  const onRestoreOrchestraAttempt = useCallback(async () => {
    if (!selectedThreadShell) return;
    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    if (!(await awaitComposerDraftsLoaded())) {
      setOrchestraError({ threadKey, message: "저장된 전송 기록을 읽지 못했습니다." });
      return;
    }
    const attempt = getComposerDraftSnapshot(threadKey).orchestraAttempt;
    if (!attempt || orchestraSendingRef.current.has(threadKey)) return;
    setOrchestraBusy(threadKey, true);
    try {
      const current = getComposerDraftSnapshot(threadKey);
      if (
        attempt.originalAttachments.some((original) =>
          current.attachments.some(
            (image) =>
              image.id === original.id &&
              (image.dataUrl !== original.dataUrl ||
                image.name !== original.name ||
                image.mimeType !== original.mimeType ||
                image.sizeBytes !== original.sizeBytes),
          ),
        )
      ) {
        setOrchestraError({
          threadKey,
          message: "같은 이미지 ID의 내용이 달라 이전 요청을 보존했습니다.",
        });
        return;
      }
      const merged = await mergeComposerDraftContent(threadKey, {
        text: attempt.originalText,
        attachments: attempt.originalAttachments,
      });
      if (merged.skippedAttachmentCount > 0) {
        setOrchestraError({
          threadKey,
          message: "초안에 모든 이미지를 복원할 수 없어 이전 요청을 보존했습니다.",
        });
        return;
      }
      clearComposerOrchestraAttempt(threadKey, attempt.commandId);
      setOrchestraError(null);
    } catch (error) {
      setOrchestraError({
        threadKey,
        message:
          error instanceof Error ? error.message : "이전 요청을 초안으로 복원하지 못했습니다.",
      });
    } finally {
      setOrchestraBusy(threadKey, false);
    }
  }, [selectedThreadShell, setOrchestraBusy]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const loaded = await awaitComposerDraftsLoaded();
    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    if (!loaded) {
      setOrchestraError({
        threadKey,
        message: "저장된 초안과 이전 전송 기록을 읽지 못해 메시지를 보내지 않았습니다.",
      });
      return null;
    }

    const pendingStart = draft.orchestraStartAttempt;
    if (pendingStart) {
      if (draft.text === pendingStart.originalText && draft.attachments.length === 0)
        await submitOrchestraStartAttempt(selectedThreadShell.environmentId, pendingStart);
      else
        setOrchestraError({
          threadKey,
          message: "이전 시작 요청의 접수 여부를 확인한 뒤 새 내용을 보내세요.",
        });
      return null;
    }
    const pending = draft.orchestraAttempt;
    if (pending) {
      if (orchestraAttemptMatchesContent(draft, pending))
        await submitOrchestraAttempt(selectedThreadShell.environmentId, pending);
      else
        setOrchestraError({
          threadKey,
          message:
            "이전 요청의 접수 여부가 미확인입니다. 이전 요청을 확인한 뒤 새 내용을 보내세요.",
        });
      return null;
    }
    if (activeOrchestra) {
      const prepared = prepareThreadOrchestraMessage(activeOrchestra, {
        text: draft.text,
        attachmentCount: attachments.length,
      });
      if (prepared.kind === "hold") {
        setOrchestraError({ threadKey, message: prepared.reason });
        return null;
      }
      if (prepared.kind === "empty") return null;
      const metadata = makeQueuedMessageMetadata();
      await submitOrchestraAttempt(selectedThreadShell.environmentId, {
        threadKey,
        projectId: activeOrchestra.projectId,
        runId: activeOrchestra.id,
        prepared,
        originalText: draft.text,
        originalAttachments: attachments,
        commandId: CommandId.make(metadata.commandId),
        createdAt: metadata.createdAt,
      });
      return null;
    }

    if (draft.orchestraConfig?.enabled) {
      if (attachments.length > 0) {
        setOrchestraError({
          threadKey,
          message: "통합 작업 목표에는 이미지를 첨부할 수 없어 초안에 보존했습니다.",
        });
        return null;
      }
      if (activeThreadBusy || selectedThreadQueuedMessages.length > 0) {
        setOrchestraError({
          threadKey,
          message: "현재 대화 작업과 대기 메시지가 끝난 뒤 통합 작업을 시작하세요.",
        });
        return null;
      }
      if (runsQuery.data === null || !environmentRuntime?.serverConfig) {
        runsQuery.refresh();
        setOrchestraError({
          threadKey,
          message: "통합 작업과 AI 연결 상태를 확인한 뒤 다시 보내세요.",
        });
        return null;
      }
      const prepared = createMobileOrchestraStart({
        config: draft.orchestraConfig,
        projectId: selectedThreadShell.projectId,
        threadId: selectedThreadShell.id,
        currentModel: draft.modelSelection ?? thread.modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: draft.interactionMode ?? thread.interactionMode,
        task: draft.text,
        requestId: uuidv4(),
        availableModels: buildModelOptions(environmentRuntime.serverConfig, null).map(
          (option) => option.selection,
        ),
      });
      if (!prepared.start) {
        setOrchestraError({ threadKey, message: prepared.error ?? "통합 작업 설정을 확인하세요." });
        return null;
      }
      await submitOrchestraStartAttempt(selectedThreadShell.environmentId, {
        threadKey,
        originalText: draft.text,
        config: draft.orchestraConfig,
        input: prepared.start,
      });
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection: draft.modelSelection ?? thread.modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: draft.interactionMode ?? thread.interactionMode,
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [
    activeOrchestra,
    activeThreadBusy,
    environmentRuntime?.serverConfig,
    runsQuery.data,
    runsQuery.refresh,
    selectedThreadDetail,
    selectedThreadQueuedMessages.length,
    selectedThreadShell,
    submitOrchestraAttempt,
    submitOrchestraStartAttempt,
  ]);

  const onStopOrchestra = useCallback(async () => {
    if (!selectedThreadShell || !activeOrchestra || activeOrchestra.status === "cancel-requested")
      return;
    const result = await cancelOrchestra({
      environmentId: selectedThreadShell.environmentId,
      input: { projectId: activeOrchestra.projectId, runId: activeOrchestra.id },
    });
    if (result._tag !== "Success")
      setOrchestraError({
        threadKey: scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id),
        message: "통합 작업을 중지하지 못했습니다.",
      });
    runsQuery.refresh();
  }, [activeOrchestra, cancelOrchestra, runsQuery.refresh, selectedThreadShell]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      existingBytes:
        composerDrafts[threadKey]?.attachments.reduce(
          (total, attachment) => total + attachment.sizeBytes,
          0,
        ) ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      existingBytes:
        composerDrafts[threadKey]?.attachments.reduce(
          (total, attachment) => total + attachment.sizeBytes,
          0,
        ) ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
          existingBytes:
            composerDrafts[threadKey]?.attachments.reduce(
              (total, attachment) => total + attachment.sizeBytes,
              0,
            ) ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onRetryFailedMessage = useCallback(async (message: QueuedThreadMessage) => {
    const { deliveryFailure: _failure, ...retry } = message;
    try {
      if (await updateThreadOutboxMessageIfCurrent(message, retry))
        releaseEditingQueuedMessage(message.messageId);
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "대기 메시지를 다시 시도할 수 없습니다.",
      );
    }
  }, []);

  const onRestoreFailedMessage = useCallback(async (message: QueuedThreadMessage) => {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    try {
      const result = await mergeComposerDraftContent(threadKey, {
        text: message.text,
        attachments: message.attachments,
      });
      if (result.skippedAttachmentCount > 0) {
        setPendingConnectionError(
          "초안에 모든 첨부를 넣을 수 없어 기존 대기 메시지를 보존했습니다. 초안의 첨부를 정리한 뒤 다시 시도하세요.",
        );
        return;
      }
      if (!(await removeThreadOutboxMessageIfCurrent(message))) {
        setPendingConnectionError("대기 메시지가 변경되어 삭제하지 않았습니다. 초안을 확인하세요.");
      }
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "대기 메시지를 초안으로 옮기지 못했습니다.",
      );
    }
  }, []);

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    selectedThreadFailedMessage,
    onRetryFailedMessage,
    onRestoreFailedMessage,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    activeOrchestra,
    orchestraError: orchestraError?.threadKey === selectedThreadKey ? orchestraError.message : null,
    hasOrchestraAttempt: selectedDraft?.orchestraAttempt !== undefined,
    hasOrchestraStartAttempt: selectedDraft?.orchestraStartAttempt !== undefined,
    orchestraConfig: selectedDraft?.orchestraConfig ?? DEFAULT_MOBILE_ORCHESTRA_CONFIG,
    onChangeOrchestraConfig,
    onRetryOrchestraStart,
    onRestoreOrchestraStart,
    orchestraAttemptBusy: selectedThreadKey !== null && orchestraBusyThreads.has(selectedThreadKey),
    onRetryOrchestraAttempt,
    onRestoreOrchestraAttempt,
    onStopOrchestra,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
