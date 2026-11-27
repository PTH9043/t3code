import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ChangeRequestStateLike } from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_CHAT_HORIZONTAL_INSET_PX,
  MAX_CHAT_HORIZONTAL_INSET_PX,
  MIN_CHAT_HORIZONTAL_INSET_PX,
} from "@t3tools/contracts/settings";
import { ChevronDownIcon, EyeIcon, MoveHorizontalIcon, WorkflowIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadBackgroundWatch } from "./ThreadBackgroundWatch";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  /** PR state feeding the settled classification, resolved by ChatView. */
  changeRequestState: ChangeRequestStateLike | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  viewerControl: ReactNode;
  workerEngineControl?: ReactNode;
  gitCwd: string | null;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  backgroundTasks?: readonly UnifiedBgTask[];
  onStopBackgroundWork?: () => void;
  isStoppingBackgroundWork?: boolean;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

const CHAT_HORIZONTAL_INSET_PRESETS: ReadonlyArray<{
  readonly label: string;
  readonly value: number | null;
}> = [
  { label: "자동", value: null },
  { label: "12px", value: 12 },
  { label: "48px", value: 48 },
  { label: "96px", value: 96 },
];

export function ChatHorizontalInsetControl() {
  const chatHorizontalInsetPx = useClientSettings(
    (settings) => settings.chatHorizontalInsetPx ?? DEFAULT_CHAT_HORIZONTAL_INSET_PX,
  );
  const updateClientSettings = useUpdateClientSettings();
  const isCustom = chatHorizontalInsetPx !== DEFAULT_CHAT_HORIZONTAL_INSET_PX;
  const insetLabel = chatHorizontalInsetPx === null ? "자동" : `${chatHorizontalInsetPx}px`;
  const sliderValue = chatHorizontalInsetPx ?? 48;
  const sliderRatio =
    (sliderValue - MIN_CHAT_HORIZONTAL_INSET_PX) /
    (MAX_CHAT_HORIZONTAL_INSET_PX - MIN_CHAT_HORIZONTAL_INSET_PX);
  const sliderStyle = {
    "--settings-slider-progress": `${sliderRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - sliderRatio}rem`,
  } as CSSProperties;

  return (
    <Popover>
      <PopoverTrigger
        data-chat-header-actions
        data-toolbar-control
        aria-label={`대화방 좌우 여백 조절 (${insetLabel})`}
        title={`대화방 좌우 여백 (${insetLabel})`}
        className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
      >
        <MoveHorizontalIcon aria-hidden className="size-4" />
        {isCustom ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-64 p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">대화방 좌우 여백</span>
            <output
              className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-foreground"
              htmlFor="chat-header-horizontal-inset"
            >
              {insetLabel}
            </output>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            대화방과 양옆 경계선 사이의 간격을 조절합니다.
          </p>
          <input
            id="chat-header-horizontal-inset"
            aria-label="대화방 좌우 여백"
            className="settings-slider w-full"
            type="range"
            min={MIN_CHAT_HORIZONTAL_INSET_PX}
            max={MAX_CHAT_HORIZONTAL_INSET_PX}
            step={4}
            style={sliderStyle}
            value={sliderValue}
            onChange={(event) => {
              const nextValue = Number(event.currentTarget.value);
              if (
                Number.isInteger(nextValue) &&
                nextValue >= MIN_CHAT_HORIZONTAL_INSET_PX &&
                nextValue <= MAX_CHAT_HORIZONTAL_INSET_PX
              ) {
                updateClientSettings({ chatHorizontalInsetPx: nextValue });
              }
            }}
          />
          <div className="grid grid-cols-4 gap-1">
            {CHAT_HORIZONTAL_INSET_PRESETS.map((preset) => {
              const active = chatHorizontalInsetPx === preset.value;
              return (
                <Button
                  key={preset.label}
                  type="button"
                  size="xs"
                  variant={active ? "secondary" : "outline"}
                  aria-pressed={active}
                  onClick={() => updateClientSettings({ chatHorizontalInsetPx: preset.value })}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ChatViewerToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const tooltipLabel = open ? "대화 뷰어 닫기" : "대화 뷰어 열기";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-chat-header-actions
            data-toolbar-control
            aria-label="대화 뷰어"
            aria-pressed={open}
            title={tooltipLabel}
            onClick={onToggle}
            className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
          />
        }
      >
        <EyeIcon aria-hidden className="size-4" />
        <span
          aria-hidden
          className={`absolute top-1 right-1 size-1.5 rounded-full ${
            open ? "bg-primary" : "bg-muted-foreground/40"
          }`}
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
    </Tooltip>
  );
}

export function ChatWorkerEngineToggle({
  open,
  activeCount = 0,
  attentionCount = 0,
  unreadCount = 0,
  onToggle,
}: {
  open: boolean;
  activeCount?: number;
  attentionCount?: number;
  unreadCount?: number;
  onToggle: () => void;
}) {
  const summaryParts = [
    activeCount > 0 ? `실행 ${activeCount}` : null,
    attentionCount > 0 ? `확인 필요 ${attentionCount}` : null,
    unreadCount > 0 ? `메일 ${unreadCount}` : null,
  ].filter((part): part is string => part !== null);
  const tooltipLabel = `${open ? "작업자 엔진 닫기" : "작업자 엔진 열기"}${
    summaryParts.length > 0 ? ` (${summaryParts.join(" · ")})` : ""
  }`;
  const dotClass =
    attentionCount > 0
      ? "bg-warning"
      : activeCount > 0
        ? "bg-info"
        : open
          ? "bg-primary"
          : "bg-muted-foreground/40";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-chat-header-actions
            data-toolbar-control
            aria-label="작업자 엔진"
            aria-pressed={open}
            title={tooltipLabel}
            onClick={onToggle}
            className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
          />
        }
      >
        <WorkflowIcon aria-hidden className="size-4" />
        <span aria-hidden className={`absolute top-1 right-1 size-1.5 rounded-full ${dotClass}`} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
    </Tooltip>
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  isServerThread,
  changeRequestState,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  viewerControl,
  workerEngineControl,
  gitCwd,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  backgroundTasks,
  onStopBackgroundWork,
  isStoppingBackgroundWork,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  if (renaming !== null && renaming.threadId !== activeThreadId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "대화 제목을 입력하세요" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "대화 이름을 바꾸지 못했습니다",
            description: "잠시 후 다시 시도하세요.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    changeRequestState,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const openMenuFromTitle = useCallback(() => {
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [openMenu]);
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!isServerThread || renamingTitle !== null) return;
      // The right-side controls (git, scripts, open-in) keep their own
      // behavior; only the breadcrumb area opens the thread menu.
      if ((event.target as HTMLElement).closest("[data-chat-header-actions]")) return;
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [isServerThread, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  const fullBreadcrumbTooltip = activeProjectCwd
    ? `${activeProjectCwd} — ${activeThreadTitle}`
    : activeProjectName
      ? `${activeProjectName} / ${activeThreadTitle}`
      : activeThreadTitle;
  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden"
      onContextMenu={handleHeaderContextMenu}
    >
      <div className="flex min-w-[180px] flex-1 basis-auto items-center gap-1.5 overflow-hidden sm:gap-2">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex min-w-0 max-w-[42%] shrink items-center gap-1.5 sm:gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${activeProjectName}에서 새 대화`}
                    title={
                      activeProjectCwd
                        ? `${activeProjectCwd} (${activeProjectName}에서 새 대화)`
                        : `${activeProjectName}에서 새 대화`
                    }
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <ProjectFavicon
                  environmentId={activeThreadEnvironmentId}
                  cwd={activeProjectCwd ?? ""}
                  className="size-3.5 shrink-0"
                />
                <span className="hidden max-w-44 truncate text-sm font-medium @[22rem]/header-actions:inline">
                  {activeProjectName}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {activeProjectCwd
                  ? `${activeProjectCwd} · 클릭하여 새 대화`
                  : `${activeProjectName}에서 새 대화`}
              </TooltipPopup>
            </Tooltip>
            <span
              aria-hidden
              className="hidden shrink-0 text-icon-muted @[22rem]/header-actions:inline"
            >
              /
            </span>
          </span>
        ) : null}
        {renamingTitle !== null ? (
          <input
            autoFocus
            aria-label="대화 제목"
            className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
            defaultValue={renamingTitle}
            onBlur={(event) => {
              if (renameCommittedRef.current) return;
              commitRename(event.currentTarget.value);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={handleRenameKeyDown}
          />
        ) : isServerThread ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={titleButtonRef}
                  type="button"
                  aria-label={`${activeThreadTitle} 대화 작업`}
                  aria-haspopup="menu"
                  title={fullBreadcrumbTooltip}
                  onClick={openMenuFromTitle}
                  className="group/thread-title inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <h2 className="min-w-0 truncate text-sm font-medium text-foreground">
                {activeThreadTitle}
              </h2>
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
              />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{fullBreadcrumbTooltip}</TooltipPopup>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <h2
                  aria-label={activeThreadTitle}
                  title={fullBreadcrumbTooltip}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                >
                  {activeThreadTitle}
                </h2>
              }
            />
            <TooltipPopup side="bottom">{fullBreadcrumbTooltip}</TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <div
          data-chat-header-actions
          aria-label="프로젝트 도구"
          role="group"
          className="flex shrink-0 items-center gap-1.5"
        >
          {activeProjectScripts && (
            <ProjectScriptsControl
              scripts={activeProjectScripts}
              fileScripts={fileScripts}
              keybindings={keybindings}
              preferredScriptId={preferredScriptId}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
            />
          )}
          {showOpenInPicker && (
            <OpenInPicker
              environmentId={activeThreadEnvironmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
          )}
          {activeProjectName && (
            <GitActionsControl
              gitCwd={gitCwd}
              activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
              {...(draftId ? { draftId } : {})}
            />
          )}
        </div>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border/60" />
        <div className="flex shrink-0 items-center gap-0.5">
          <ChatHorizontalInsetControl />
          {viewerControl}
          {workerEngineControl}
          {isServerThread && !draftId && (
            <ThreadBackgroundWatch
              key={JSON.stringify([activeThreadEnvironmentId, activeThreadId])}
              environmentId={activeThreadEnvironmentId}
              threadId={activeThreadId}
              {...(backgroundTasks ? { backgroundTasks } : {})}
              {...(onStopBackgroundWork ? { onStopBackgroundWork } : {})}
              {...(isStoppingBackgroundWork !== undefined ? { isStoppingBackgroundWork } : {})}
            />
          )}
        </div>
      </div>
    </div>
  );
});
