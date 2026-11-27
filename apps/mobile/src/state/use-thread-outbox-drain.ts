import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { resolveImportedModelSelection } from "../lib/modelOptions";
import { serverEnvironment } from "./server";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildQueuedProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { toUploadChatImageAttachments } from "../lib/composerImages";
import { turnRequestFingerprint } from "../lib/turnRequestFingerprint";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  removeThreadOutboxMessageIfCurrent,
  threadOutboxManager,
  updateThreadOutboxMessageIfCurrent,
} from "./thread-outbox";
import {
  canRetryUnconfirmedCreation,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveQueuedThreadSettings,
  shouldHoldUnconfirmedFailedAttempt,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./thread-outbox-model";
import { reconcileQueuedCreationReceipt, retainThreadOutboxFailure } from "./thread-outbox-failure";
import { matchesQueuedAttempt, prepareQueuedCreationAttempt } from "./thread-outbox-attempt";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const checkTurnReceipt = useAtomCommand(threadEnvironment.checkTurnReceipt, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
    const handleFailure = async (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): Promise<boolean> => {
      if (!AsyncResult.isFailure(commandResult)) {
        return true;
      }
      const cause = Cause.squash(commandResult.cause);
      try {
        const action = await retainThreadOutboxFailure({
          message: queuedMessage,
          stage,
          error: cause,
          interrupted: Cause.hasInterruptsOnly(commandResult.cause),
          updateIfCurrent: updateThreadOutboxMessageIfCurrent,
        });
        console.warn("[thread-outbox] queued message delivery failed", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          stage,
          cause: commandResult.cause,
          action,
        });
        return action !== "retry";
      } catch (error) {
        // Keep the current in-memory queue locked if the pause could not be
        // persisted. Never silently delete or automatically resend it.
        const key = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
        const currentQueue = appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
        if (currentQueue[key]?.includes(queuedMessage)) {
          holdEditingQueuedMessage(queuedMessage.messageId);
          setPendingConnectionError(
            `전송 확인 상태를 저장하지 못해 이 실행 중에는 메시지를 보류합니다. 앱을 다시 시작하면 재전송될 수 있습니다: ${error instanceof Error ? error.message : "저장 오류"}`,
          );
        }
      }
      return true;
    };
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<boolean> => {
      if (AsyncResult.isFailure(deliveryResult)) return handleFailure(deliveryResult, "start-turn");

      try {
        await removeThreadOutboxMessageIfCurrent(queuedMessage);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    };
    return { handleFailure, completeDelivery };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const settings = resolveQueuedThreadSettings(queuedMessage, thread);
      const { handleFailure, completeDelivery } = makeDeliveryHelpers(queuedMessage);

      if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "model-selection"),
            threadId: queuedMessage.threadId,
            modelSelection: settings.modelSelection,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          return handleFailure(updateResult, "settings-sync");
        }
      }

      if (settings.runtimeMode !== thread.runtimeMode) {
        const runtimeResult = await setThreadRuntimeMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "runtime-mode"),
            threadId: queuedMessage.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(runtimeResult)) {
          return handleFailure(runtimeResult, "settings-sync");
        }
      }

      if (settings.interactionMode !== thread.interactionMode) {
        const interactionResult = await setThreadInteractionMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "interaction-mode"),
            threadId: queuedMessage.threadId,
            interactionMode: settings.interactionMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(interactionResult)) {
          return handleFailure(interactionResult, "settings-sync");
        }
      }

      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: toUploadChatImageAttachments(queuedMessage.attachments),
          },
          modelSelection: settings.modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      return completeDelivery(deliveryResult);
    },
    [
      makeDeliveryHelpers,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startTurn,
      updateThreadMetadata,
    ],
  );

  const sendQueuedCreation = useCallback(
    async (queuedMessage: QueuedThreadMessage, projectCwd: string) => {
      let input: ReturnType<typeof buildQueuedProjectThreadStartTurnInput>;
      let preparedMessage: QueuedThreadMessage | null;
      try {
        input = buildQueuedProjectThreadStartTurnInput(queuedMessage, projectCwd);
        if (!input) return false;
        if (queuedMessage.creation?.requireExactModel) {
          const config = appAtomRegistry.get(
            serverEnvironment.configValueAtom(queuedMessage.environmentId),
          );
          if (!config) return false;
          if (!resolveImportedModelSelection(config, input.modelSelection)) {
            throw new Error(
              "복사한 계정 또는 모델을 사용할 수 없습니다. 대기 중인 작업에서 모델을 직접 선택하세요.",
            );
          }
        }
        const worktree = input.bootstrap.prepareWorktree;
        const attemptWorktree = worktree
          ? { projectCwd: worktree.projectCwd, worktreeBranchName: worktree.branch }
          : undefined;
        const fingerprint = await turnRequestFingerprint({ ...input, type: "thread.turn.start" });
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) return true;
        if (!matchesQueuedAttempt(queuedMessage, fingerprint)) {
          await reconcileQueuedCreationReceipt({
            message: queuedMessage,
            status: "mismatch",
            removeIfCurrent: removeThreadOutboxMessageIfCurrent,
            updateIfCurrent: updateThreadOutboxMessageIfCurrent,
          });
          return true;
        }
        preparedMessage = await prepareQueuedCreationAttempt({
          message: queuedMessage,
          fingerprint: async () => fingerprint,
          ...(attemptWorktree ? { attemptWorktree } : {}),
          isEditing: () =>
            Boolean(appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]),
          updateIfCurrent: updateThreadOutboxMessageIfCurrent,
        });
      } catch (error) {
        try {
          const action = await retainThreadOutboxFailure({
            message: queuedMessage,
            stage: "start-turn",
            error,
            interrupted: false,
            updateIfCurrent: updateThreadOutboxMessageIfCurrent,
          });
          return action !== "retry";
        } catch (storageError) {
          const key = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
          const currentQueue = appAtomRegistry.get(
            threadOutboxManager.queuedMessagesByThreadKeyAtom,
          );
          if (currentQueue[key]?.includes(queuedMessage)) {
            holdEditingQueuedMessage(queuedMessage.messageId);
            setPendingConnectionError(
              `전송 준비 오류를 저장하지 못해 이 실행 중에는 작업을 보류합니다: ${storageError instanceof Error ? storageError.message : "저장 오류"}`,
            );
          }
          return true;
        }
      }
      if (!preparedMessage) return true;
      const { completeDelivery } = makeDeliveryHelpers(preparedMessage);
      const deliveryResult = await startTurn({ environmentId: queuedMessage.environmentId, input });
      return completeDelivery(deliveryResult);
    },
    [makeDeliveryHelpers, startTurn],
  );

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === "connected",
        threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
        hasDeliveryFailure: nextQueuedMessage.deliveryFailure !== undefined,
        hasAttemptFingerprint: nextQueuedMessage.deliveryAttemptFingerprint !== undefined,
        receiptChecked: nextQueuedMessage.deliveryReceiptChecked === true,
      });
      if (deliveryAction === "wait") {
        continue;
      }
      // The live project shell is preferred for the workspace path, with the
      // snapshot taken at enqueue time as the fallback so a task never dies
      // just because its project shell is not loaded.
      const creationProjectCwd =
        creation !== undefined
          ? (nextQueuedMessage.deliveryAttemptWorktree?.projectCwd ??
            findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;
      // An incomplete pending task (e.g. worktree mode without a branch) stays
      // queued until the user finishes it in the editor.
      if (deliveryAction === "send" && creation !== undefined) {
        if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
          continue;
        }
        if (creationProjectCwd === null) {
          continue;
        }
      }

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          // Rolled back by a failed write; nothing to deliver or retry.
          return true;
        }
        // The guards evaluated before the confirmation await are stale by now:
        // the thread may have gone busy, or the user may have opened this
        // message in the editor. Re-read both and defer to the next drain pass
        // (returning true skips the failure/backoff path) rather than sending
        // a payload the user is editing or racing an active turn.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
          return true;
        }
        const freshThread = findThread(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          nextQueuedMessage,
        );
        const freshThreadBusy =
          freshThread?.session?.status === "running" || freshThread?.session?.status === "starting";
        if (deliveryAction === "send" && creation === undefined && freshThreadBusy) {
          return true;
        }
        if (deliveryAction === "verify" && nextQueuedMessage.deliveryAttemptFingerprint) {
          return checkTurnReceipt({
            environmentId: nextQueuedMessage.environmentId,
            input: {
              commandId: nextQueuedMessage.commandId,
              threadId: nextQueuedMessage.threadId,
              requestFingerprint: nextQueuedMessage.deliveryAttemptFingerprint,
            },
          }).then(async (result) => {
            if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId])
              return true;
            if (
              AsyncResult.isFailure(result) &&
              (Cause.hasInterruptsOnly(result.cause) ||
                shouldRetryThreadOutboxDelivery(Cause.squash(result.cause)))
            )
              return false;
            try {
              const status = AsyncResult.isFailure(result) ? "unavailable" : result.value.status;
              if (
                status === "unconfirmed" &&
                shouldHoldUnconfirmedFailedAttempt(nextQueuedMessage)
              ) {
                await updateThreadOutboxMessageIfCurrent(nextQueuedMessage, {
                  ...nextQueuedMessage,
                  deliveryReceiptChecked: true,
                });
                return true;
              }
              const latestThread = findThread(
                appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
                nextQueuedMessage,
              );
              if (
                status === "unconfirmed" &&
                !AsyncResult.isFailure(result) &&
                creation !== undefined &&
                canRetryUnconfirmedCreation({
                  creation,
                  threadExists: latestThread !== undefined,
                  projectCwd: creationProjectCwd,
                  safeBootstrapReplay: result.value.safeBootstrapReplay === true,
                  safeBootstrapResume: result.value.safeBootstrapResume === true,
                  safeWorktreeBootstrapResume: result.value.safeWorktreeBootstrapResume === true,
                  attemptWorktree: nextQueuedMessage.deliveryAttemptWorktree,
                }) &&
                creationProjectCwd !== null &&
                isQueuedThreadCreationSendable(nextQueuedMessage)
              )
                return sendQueuedCreation(nextQueuedMessage, creationProjectCwd);
              await reconcileQueuedCreationReceipt({
                message: nextQueuedMessage,
                status,
                removeIfCurrent: removeThreadOutboxMessageIfCurrent,
                updateIfCurrent: updateThreadOutboxMessageIfCurrent,
              });
              return status !== "unconfirmed";
            } catch (error) {
              console.warn("[thread-outbox] failed to persist receipt status", error);
              return false;
            }
          });
        }
        if (creation !== undefined && (deliveryAction === "hold" || freshThread !== undefined)) {
          return retainThreadOutboxFailure({
            message: nextQueuedMessage,
            stage: "start-turn",
            error:
              "대화는 만들어졌지만 첫 메시지가 접수됐는지 확인할 수 없습니다. 대화 기록을 확인한 뒤 대기 작업을 처리하세요.",
            interrupted: false,
            updateIfCurrent: updateThreadOutboxMessageIfCurrent,
          })
            .then(() => true)
            .catch((error) => {
              const key = scopedThreadKey(
                nextQueuedMessage.environmentId,
                nextQueuedMessage.threadId,
              );
              const currentQueue = appAtomRegistry.get(
                threadOutboxManager.queuedMessagesByThreadKeyAtom,
              );
              if (currentQueue[key]?.includes(nextQueuedMessage)) {
                holdEditingQueuedMessage(nextQueuedMessage.messageId);
                setPendingConnectionError(
                  `첫 메시지 확인 상태를 저장하지 못해 보류했습니다: ${error instanceof Error ? error.message : "저장 오류"}`,
                );
              }
              return true;
            });
        }
        return creation !== undefined
          ? creationProjectCwd !== null
            ? sendQueuedCreation(nextQueuedMessage, creationProjectCwd)
            : Promise.resolve(true)
          : thread !== undefined
            ? sendQueuedMessage(nextQueuedMessage, thread)
            : Promise.resolve(false);
      });
      void delivery
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    checkTurnReceipt,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedCreation,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}
