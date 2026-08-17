import { useLocation } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

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
 * the tab layer owns showing it. Plain navigation retargets the current tab;
 * a view already open in another tab activates that tab instead.
 */
export function useSyncWorkspaceTabRoute(view: WorkspaceTabView | null): void {
  const syncRouteView = useWorkspaceTabStore((state) => state.syncRouteView);
  const viewKey = view === null ? null : workspaceTabViewKey(view);
  useEffect(() => {
    if (view !== null) {
      syncRouteView(view);
    }
    // The key captures the view's identity; the object is rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, syncRouteView]);
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
