import type { OrchestrationThreadShell } from "@t3tools/contracts";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MAX_WORKSPACE_TABS,
  useActiveWorkspaceTabId,
  useWorkspaceTabStore,
  useWorkspaceTabs,
  type WorkspaceTab,
} from "../../workspaceTabStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { navigateToTabView } from "./navigateToTabView";
import { cn } from "~/lib/utils";

/**
 * One dot, most urgent first: the person's attention is a queue, not a
 * dashboard. 응답 대기 > 오류 > 진행 중 > 완료.
 */
type TabBadge = "awaiting-input" | "error" | "working" | "completed" | null;

function badgeForThreadShell(
  shell: OrchestrationThreadShell | null,
  input: { readonly active: boolean; readonly seenTurnId: string | undefined },
): TabBadge {
  if (shell === null) return null;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "awaiting-input";
  const session = shell.session;
  const latestTurn = shell.latestTurn;
  if (latestTurn?.state === "error" || (session?.lastError ?? null) !== null) return "error";
  if (
    session?.status === "running" ||
    session?.status === "starting" ||
    latestTurn?.state === "running" ||
    (shell.backgroundLiveness ?? null) !== null
  ) {
    return "working";
  }
  if (
    !input.active &&
    latestTurn !== null &&
    (latestTurn.state === "completed" || latestTurn.state === "interrupted") &&
    input.seenTurnId !== latestTurn.turnId
  ) {
    return "completed";
  }
  return null;
}

// Stepped pulses, never a spinner: the tab strip is always on screen, and a
// continuously rotating icon ticks style every frame for as long as any
// folder has a live run (measured ~60 style recalcs/s on an idle renderer).
function TabBadgeDot({ badge }: { badge: TabBadge }) {
  if (badge === null) return null;
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        badge === "working" && "animate-status-pulse bg-muted-foreground",
        badge === "awaiting-input" && "animate-status-pulse bg-amber-500",
        badge === "error" && "bg-destructive",
        badge === "completed" && "bg-emerald-500",
      )}
    />
  );
}

function TabItemShell(props: {
  readonly tab: WorkspaceTab;
  readonly index: number;
  readonly active: boolean;
  readonly title: string;
  readonly badge: TabBadge;
}) {
  const navigate = useNavigate();
  const { tab, index, active } = props;
  const activateTab = useWorkspaceTabStore((state) => state.activateTab);
  const closeTab = useWorkspaceTabStore((state) => state.closeTab);
  const moveTab = useWorkspaceTabStore((state) => state.moveTab);

  const open = useCallback(() => {
    activateTab(tab.id);
    navigateToTabView(navigate, tab.view);
  }, [activateTab, navigate, tab.id, tab.view]);

  const close = useCallback(() => {
    const wasActive = useWorkspaceTabStore.getState().activeTabId === tab.id;
    const next = closeTab(tab.id);
    if (!wasActive) return;
    if (next) {
      navigateToTabView(navigate, next.view);
    } else {
      void navigate({ to: "/" });
    }
  }, [closeTab, navigate, tab.id]);

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      draggable
      data-tab-index={index}
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-t3-tab-index", String(index));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-t3-tab-index")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData("application/x-t3-tab-index");
        const fromIndex = Number.parseInt(raw, 10);
        if (Number.isInteger(fromIndex)) {
          event.preventDefault();
          moveTab(fromIndex, index);
        }
      }}
      onClick={open}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          close();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      className={cn(
        "group flex h-8 min-w-0 max-w-52 flex-none cursor-pointer select-none items-center gap-1.5 rounded-t-md border border-b-0 border-border/60 px-2.5 text-xs",
        active
          ? "bg-background text-foreground"
          : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
      title={props.title}
    >
      <TabBadgeDot badge={props.badge} />
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      <button
        type="button"
        aria-label="탭 닫기"
        onClick={(event) => {
          event.stopPropagation();
          close();
        }}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

function ThreadTabItem(props: { readonly tab: WorkspaceTab; readonly index: number }) {
  const view = props.tab.view;
  const active = useActiveWorkspaceTabId() === props.tab.id;
  const threadRef =
    view.kind === "thread"
      ? scopeThreadRef(view.environmentId as EnvironmentId, view.threadId as ThreadId)
      : null;
  const shell = useThreadShell(threadRef);
  const seenTurnId = useWorkspaceTabStore((state) => state.seenTurnByTabId[props.tab.id]);
  const markTurnSeen = useWorkspaceTabStore((state) => state.markTurnSeen);

  const latestTurnId = shell?.latestTurn?.turnId;
  useEffect(() => {
    if (active && latestTurnId !== undefined) {
      markTurnSeen(props.tab.id, latestTurnId);
    }
  }, [active, latestTurnId, markTurnSeen, props.tab.id]);

  return (
    <TabItemShell
      tab={props.tab}
      index={props.index}
      active={active}
      title={shell?.title ?? "대화"}
      badge={badgeForThreadShell(shell, { active, seenTurnId })}
    />
  );
}

function DraftTabItem(props: { readonly tab: WorkspaceTab; readonly index: number }) {
  const active = useActiveWorkspaceTabId() === props.tab.id;
  return (
    <TabItemShell
      tab={props.tab}
      index={props.index}
      active={active}
      title="새 대화"
      badge={null}
    />
  );
}

function ControlCenterTabItem(props: { readonly tab: WorkspaceTab; readonly index: number }) {
  const view = props.tab.view;
  const active = useActiveWorkspaceTabId() === props.tab.id;
  const projects = useProjects();
  const threadShells = useThreadShells();
  const project =
    view.kind === "control-center"
      ? (projects.find(
          (candidate) =>
            candidate.environmentId === view.environmentId && candidate.id === view.projectId,
        ) ?? null)
      : null;

  // The control center speaks for its whole project, so its dot aggregates
  // every thread in it.
  let badge: TabBadge = null;
  if (view.kind === "control-center") {
    const projectThreads = threadShells.filter(
      (shell) => shell.projectId === view.projectId && shell.environmentId === view.environmentId,
    );
    if (projectThreads.some((shell) => shell.hasPendingApprovals || shell.hasPendingUserInput)) {
      badge = "awaiting-input";
    } else if (
      projectThreads.some(
        (shell) =>
          shell.latestTurn?.state === "error" || (shell.session?.lastError ?? null) !== null,
      )
    ) {
      badge = "error";
    } else if (
      projectThreads.some(
        (shell) =>
          shell.session?.status === "running" ||
          shell.session?.status === "starting" ||
          shell.latestTurn?.state === "running" ||
          (shell.backgroundLiveness ?? null) !== null,
      )
    ) {
      badge = "working";
    }
  }

  return (
    <TabItemShell
      tab={props.tab}
      index={props.index}
      active={active}
      title={project ? `제어센터 · ${project.title}` : "제어센터"}
      badge={badge}
    />
  );
}

export function WorkspaceTabBar() {
  const tabs = useWorkspaceTabs();
  const activeTabId = useActiveWorkspaceTabId();
  const navigate = useNavigate();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const newThreadInFlightRef = useRef(false);
  const [, forceRender] = useState(0);
  void forceRender;

  const openNewTab = useCallback(async () => {
    if (newThreadInFlightRef.current) return;
    if (tabs.length >= MAX_WORKSPACE_TABS) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `탭은 ${MAX_WORKSPACE_TABS}개까지입니다`,
          description: "오래 보지 않은 탭을 닫고 다시 열어주세요.",
        }),
      );
      return;
    }
    newThreadInFlightRef.current = true;
    try {
      // No active tab means the next route lands in a fresh tab.
      useWorkspaceTabStore.setState({ activeTabId: null });
      await startNewThreadFromContext({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      });
    } finally {
      newThreadInFlightRef.current = false;
    }
  }, [activeDraftThread, activeThread, defaultProjectRef, handleNewThread, tabs.length]);

  // Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+W closes — the browser vocabulary.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Tab") {
        if (tabs.length < 2) return;
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.id === activeTabId);
        const nextIndex = (index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        if (!next) return;
        useWorkspaceTabStore.getState().activateTab(next.id);
        navigateToTabView(navigate, next.view);
        return;
      }
      if ((event.key === "w" || event.key === "W") && !event.shiftKey) {
        if (activeTabId === null) return;
        event.preventDefault();
        const next = useWorkspaceTabStore.getState().closeTab(activeTabId);
        if (next) {
          navigateToTabView(navigate, next.view);
        } else {
          void navigate({ to: "/" });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, navigate, tabs]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      role="tablist"
      className="flex h-9 flex-none items-end gap-1 overflow-x-auto border-b border-border/60 bg-muted/20 px-2 pt-1"
    >
      {tabs.map((tab, index) =>
        tab.view.kind === "thread" ? (
          <ThreadTabItem key={tab.id} tab={tab} index={index} />
        ) : tab.view.kind === "draft" ? (
          <DraftTabItem key={tab.id} tab={tab} index={index} />
        ) : (
          <ControlCenterTabItem key={tab.id} tab={tab} index={index} />
        ),
      )}
      <button
        type="button"
        aria-label="새 탭"
        onClick={() => void openNewTab()}
        className="mb-0.5 flex size-7 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PlusIcon className="size-4" />
      </button>
    </div>
  );
}
