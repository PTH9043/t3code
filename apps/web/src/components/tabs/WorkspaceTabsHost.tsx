import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  useActiveWorkspaceTabId,
  useWorkspaceTabStore,
  useWorkspaceTabs,
  workspaceTabViewKey,
  type WorkspaceTabView,
} from "../../workspaceTabStore";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { WorkspaceTabPane } from "./WorkspaceTabPanes";

function viewPathname(view: WorkspaceTabView): string {
  switch (view.kind) {
    case "thread":
      return `/${view.environmentId}/${view.threadId}`;
    case "draft":
      return `/draft/${view.draftId}`;
    case "control-center":
      return `/control-center/${view.environmentId}/${view.projectId}`;
  }
}

function pathnameMatchesView(pathname: string, view: WorkspaceTabView): boolean {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  return decoded === viewPathname(view) || pathname === viewPathname(view);
}

/**
 * Route components call this instead of rendering: the URL names the screen,
 * the tab layer owns showing it. Same-folder navigation retargets the current
 * tab; a view already open elsewhere activates that tab; crossing into a
 * different folder reuses that folder's tab or opens a new one, so the tab
 * the person was on survives.
 */
export function useSyncWorkspaceTabRoute(view: WorkspaceTabView | null): void {
  const syncRouteView = useWorkspaceTabStore((state) => state.syncRouteView);
  const viewKey = view === null ? null : workspaceTabViewKey(view);

  // Which folder the screen belongs to. Hooks must run unconditionally, so
  // each source is probed with a null request when the view is another kind.
  const threadRef =
    view?.kind === "thread"
      ? scopeThreadRef(view.environmentId as EnvironmentId, view.threadId as ThreadId)
      : null;
  const threadShell = useThreadShell(threadRef);
  const draftSession = useComposerDraftStore((store) =>
    view?.kind === "draft" ? store.getDraftSession(DraftId.make(view.draftId)) : null,
  );
  const projectKey =
    view === null
      ? null
      : view.kind === "control-center"
        ? `${view.environmentId}:${view.projectId}`
        : view.kind === "thread"
          ? threadShell === null
            ? null
            : `${threadShell.environmentId}:${threadShell.projectId}`
          : draftSession === null
            ? null
            : `${draftSession.environmentId}:${draftSession.projectId}`;

  useEffect(() => {
    if (view !== null) {
      syncRouteView(view, { projectKey });
    }
    // The key captures the view's identity; the object is rebuilt per render.
  }, [viewKey, projectKey, syncRouteView]);
}

/**
 * The tab layer between the sidebar and the routed screens. Every tab stays
 * fully mounted (background ones hidden), so switching is instant and live
 * work — a streaming meeting, a running turn — keeps rendering unseen.
 * Routes that are not tab-shaped (the index landing, the control-center
 * overview) fall through to `children` untouched.
 */
export function WorkspaceTabsHost({ children }: { children: ReactNode }) {
  const tabs = useWorkspaceTabs();
  const activeTabId = useActiveWorkspaceTabId();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const paneVisible = activeTab !== null && pathnameMatchesView(pathname, activeTab.view);

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-1 flex-col md:h-dvh">
      {tabs.length > 0 ? (
        <div className="workspace-window-titlebar drag-region" aria-hidden="true" />
      ) : null}
      <WorkspaceTabBar />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {tabs.map((tab) => (
          <WorkspaceTabPane key={tab.id} tab={tab} active={paneVisible && tab.id === activeTabId} />
        ))}
        <div className={paneVisible ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
          {children}
        </div>
      </div>
    </div>
  );
}
