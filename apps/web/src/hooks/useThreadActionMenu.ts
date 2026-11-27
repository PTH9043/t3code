import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { resolveSnoozePresets, snoozeWakeDescription } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
} from "../state/entities";
import { useRightPanelStore } from "../rightPanelStore";
import { readLocalApi } from "../localApi";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  console.error(error);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: "작업 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
    }),
  );
}

/**
 * The per-thread action menu (pin, settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  /** PR state feeding auto-settle classification, as resolved by the caller. */
  readonly changeRequestState: ChangeRequestStateLike | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, changeRequestState, onStartRename } = input;
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "경로를 복사했습니다", description: path });
    },
    onError: (error) => failureToast("경로를 복사하지 못했습니다", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "브랜치 이름",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "브랜치를 복사했습니다", description: branch });
    },
    onError: (error) => failureToast("브랜치를 복사하지 못했습니다", error),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
          openInFileManager: Boolean(thread.worktreePath ?? projectCwd),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const items = buildThreadActionMenuItems({
          branch: thread.branch ?? null,
          isPinned: thread.pinnedAt != null,
          isSettled:
            supports.settlement &&
            effectiveSettled(thread, {
              // Minute-quantized like useNowMinute, so this classification
              // can never disagree with the sidebar partition or ChatView's
              // parked-thread banner within the same minute.
              now: `${now.toISOString().slice(0, 16)}:00.000Z`,
              autoSettleAfterDays,
              changeRequestState,
            }),
          isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
          canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
          isRegeneratingTitle,
          supports,
          snoozePresets,
        });
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadActionMenuId = clicked.value;
        if (action.startsWith("snooze:")) {
          const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              failureToast("대화를 미루지 못했습니다", squashAtomCommandFailure(result));
            }
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}까지 미뤘습니다`,
              timeout: 5_000,
              actionProps: {
                children: "실행 취소",
                onClick: () => {
                  void unsnoozeThread(threadRef).then((undone) => {
                    if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                      failureToast("대화를 깨우지 못했습니다", squashAtomCommandFailure(undone));
                    }
                  });
                },
              },
            }),
          );
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };
        switch (action) {
          case "open-viewer":
            useRightPanelStore.getState().open(threadRef, "agents");
            return;
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("새 대화를 만들지 못했습니다", squashAtomCommandFailure(result));
            }
            return;
          }
          case "settle":
            await reportFailure("대화를 완료 처리하지 못했습니다", () => settleThread(threadRef));
            return;
          case "unsettle":
            await reportFailure("대화 완료 상태를 해제하지 못했습니다", () =>
              unsettleThread(threadRef),
            );
            return;
          case "unsnooze":
            await reportFailure("대화를 깨우지 못했습니다", () => unsnoozeThread(threadRef));
            return;
          case "pin":
            await reportFailure("대화를 고정하지 못했습니다", () => pinThread(threadRef));
            return;
          case "unpin":
            await reportFailure("대화 고정을 해제하지 못했습니다", () => unpinThread(threadRef));
            return;
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("대화 제목을 다시 만들지 못했습니다", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(scopedThreadKey(threadRef), thread.latestTurn?.completedAt);
            return;
          case "open-in-file-manager": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "폴더를 열 수 없습니다",
                  description: "이 대화에는 열 수 있는 작업공간 경로가 없습니다.",
                }),
              );
              return;
            }
            await reportFailure("파일 탐색기에서 열지 못했습니다", () =>
              openInEditor({
                environmentId: threadRef.environmentId,
                input: { cwd: workspacePath, editor: "file-manager" },
              }),
            );
            return;
          }
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "경로를 사용할 수 없습니다",
                  description: "이 대화에는 복사할 작업공간 경로가 없습니다.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `"${thread.title}" 대화를 삭제할까요?`,
                    "이 대화의 기록이 영구적으로 삭제됩니다.",
                  ].join("\n"),
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const deleted = await deleteThread(threadRef);
            if (
              deleted._tag === "Failure" &&
              !isAtomCommandInterrupted(deleted) &&
              // A failure with the thread already gone is worktree cleanup
              // failing after a successful delete — deleteThread has toasted
              // that itself, and "Failed to delete thread" would be a lie.
              readThreadShell(threadRef) !== null
            ) {
              failureToast("대화를 삭제하지 못했습니다", squashAtomCommandFailure(deleted));
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      autoSettleAfterDays,
      changeRequestState,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      deleteThread,
      handleNewThread,
      markThreadUnread,
      onStartRename,
      openInEditor,
      pinThread,
      projectCwd,
      settleThread,
      snoozeThread,
      threadRef,
      timestampFormat,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  return { openMenu };
}
