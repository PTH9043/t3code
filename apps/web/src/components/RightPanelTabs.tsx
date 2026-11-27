import type { ContextMenuItem, PreviewSessionSnapshot } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Bot, FileDiff, Files, Globe2, Plus, TerminalSquare, Workflow, X } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { formatTerminalNameForDisplay } from "~/lib/terminalContext";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddAgents: () => void;
  onAddWorkers: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  children: ReactNode;
}

const SURFACE_DISABLED_REASONS = {
  browser: "브라우저 미리보기는 T3 Code 데스크톱 앱에서만 사용할 수 있습니다.",
  files: "프로젝트가 열려 있을 때만 파일을 사용할 수 있습니다.",
  diff: "Git 저장소의 서버 대화에서만 차이를 확인할 수 있습니다.",
} as const;

type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
    >
      {props.children}
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddAgents: () => void;
  onAddWorkers: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
}) {
  const actions = [
    {
      label: "브라우저",
      description: "로컬 앱이나 URL을 엽니다.",
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "터미널",
      description: "이 작업 공간에서 셸을 시작합니다.",
      icon: TerminalSquare,
      available: true,
      disabledReason: null,
      onClick: props.onAddTerminal,
    },
    {
      label: "파일",
      description: "작업 공간 파일을 탐색하고 읽습니다.",
      icon: Files,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "차이",
      description: "이 대화의 변경 사항을 검토합니다.",
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "대화 뷰어",
      description: "최근 턴과 작업 배정, 하위 에이전트 활동을 확인합니다.",
      icon: Bot,
      available: true,
      disabledReason: null,
      onClick: props.onAddAgents,
    },
    {
      label: "작업자 엔진",
      description: "실행 중 작업자·메일박스·승인 게이트·Worktree Diff를 제어합니다.",
      icon: Workflow,
      available: true,
      disabledReason: null,
      onClick: props.onAddWorkers,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">화면 열기</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            오른쪽 패널에 표시할 항목을 선택하세요.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <Icon className="mb-3 size-5" />
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  {content}
                </button>
              );
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left opacity-40 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                aria-disabled="true"
              >
                {content}
              </button>
            );
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={disabledCard}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "diff":
      return "차이";
    case "files":
      return "파일";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return formatTerminalNameForDisplay(
        terminalLabelsById.get(surface.activeTerminalId) ??
          getTerminalLabel(surface.activeTerminalId),
      );
    case "agents":
      return "대화 뷰어";
    case "workers":
      return "작업자 엔진";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "브라우저";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "브라우저";
      } catch {
        return "브라우저";
      }
    }
  }
}

function PreviewFavicon({ url }: { url: string | null }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) return <Globe2 className="size-3 shrink-0" />;
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3 shrink-0 rounded-sm"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

function SurfaceIcon({
  surface,
  sessions,
  theme,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "agents":
      return <Bot className="size-3 shrink-0" />;
    case "workers":
      return <Workflow className="size-3 shrink-0" />;
  }
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "경로 복사" });
      }
      items.push(
        { id: "close", label: "닫기" },
        {
          id: "close-others",
          label: "다른 탭 닫기",
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "오른쪽 탭 닫기",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: "모두 닫기",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          "workspace-topbar gap-1 pl-2 pr-3",
          props.mode !== "inline" && "[--workspace-topbar-height:--spacing(11)]",
          ownsDesktopTitleBar && "wco:pr-[var(--workspace-native-controls-inset)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            {props.surfaces.map((surface) => {
              const active = surface.id === props.activeSurfaceId;
              const pending = props.pendingSurfaceIds.has(surface.id);
              const title = surfaceTitle(surface, props.previewSessions, props.terminalLabelsById);
              return (
                <div
                  key={surface.id}
                  data-active-tab={active}
                  onMouseDown={handleTabMouseDown}
                  onAuxClick={(event) => handleTabAuxClick(event, surface)}
                  onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                  className={cn(
                    "group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    className="group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                    aria-label={`Close ${title}`}
                    onClick={() => props.onCloseSurface(surface)}
                  >
                    <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
                      <SurfaceIcon
                        surface={surface}
                        sessions={props.previewSessions}
                        theme={resolvedTheme}
                      />
                      {pending ? (
                        <span
                          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                          aria-hidden
                        />
                      ) : null}
                    </span>
                    <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
                  </button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="flex min-w-0 items-center"
                          onClick={() => props.onActivate(surface)}
                        >
                          <span className="truncate">{title}</span>
                        </button>
                      }
                    />
                    <TooltipPopup>{title}</TooltipPopup>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </ScrollArea>
        {props.surfaces.length > 0 ? (
          <Menu>
            <MenuTrigger
              className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="패널 화면 추가"
            >
              <Plus className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
              <SurfaceMenuItem
                available={props.browserAvailable}
                disabledReason={SURFACE_DISABLED_REASONS.browser}
                onClick={props.onAddBrowser}
              >
                <Globe2 />
                브라우저
              </SurfaceMenuItem>
              <SurfaceMenuItem available onClick={props.onAddTerminal}>
                <TerminalSquare />
                터미널
              </SurfaceMenuItem>
              <SurfaceMenuItem
                available={props.filesAvailable}
                disabledReason={SURFACE_DISABLED_REASONS.files}
                onClick={props.onAddFiles}
              >
                <Files />
                파일
              </SurfaceMenuItem>
              <SurfaceMenuItem
                available={props.diffAvailable}
                disabledReason={SURFACE_DISABLED_REASONS.diff}
                onClick={props.onAddDiff}
              >
                <FileDiff />
                차이
              </SurfaceMenuItem>
              <SurfaceMenuItem available onClick={props.onAddAgents}>
                <Bot />
                대화 뷰어
              </SurfaceMenuItem>
              <SurfaceMenuItem available onClick={props.onAddWorkers}>
                <Workflow />
                작업자 엔진
              </SurfaceMenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddAgents={props.onAddAgents}
            onAddWorkers={props.onAddWorkers}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
