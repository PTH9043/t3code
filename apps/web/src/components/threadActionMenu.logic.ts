import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy-path"
  | "copy-branch"
  | "delete";

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu both render exactly this list, so labels,
 * ordering, and capability gating cannot drift between the two surfaces.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `${state.branch}에서 새 대화 시작`,
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "대화 고정 해제" }
            : { id: "pin" as const, label: "대화 고정" },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "완료 상태 해제" }
            : { id: "settle" as const, label: "완료 처리" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "대화 깨우기" }
            : {
                id: "snooze" as const,
                label: "다시 알림",
                disabled: !state.canSnoozeNow,
                children: state.snoozePresets.map((preset) => ({
                  id: `snooze:${preset.id}` as const,
                  label: `${preset.label} (${preset.whenLabel})`,
                })),
              },
        ]
      : []),
    { id: "rename", label: "대화 이름 바꾸기" },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "제목 다시 만드는 중…" : "제목 다시 만들기",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "읽지 않음으로 표시" },
    { id: "copy-path", label: "경로 복사", icon: "copy" },
    ...(state.branch ? [{ id: "copy-branch" as const, label: "브랜치 복사", icon: "copy" }] : []),
    { id: "delete", label: "삭제", destructive: true, icon: "trash" },
  ];
}
