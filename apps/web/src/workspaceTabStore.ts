import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

/**
 * One workspace tab = the screen it is showing. "자유 단위": a tab can hold
 * any thread, draft composer, or a project's control center — whatever the
 * person last navigated it to, the way a browser tab holds its last page.
 */
export type WorkspaceTabView =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "control-center"; readonly environmentId: string; readonly projectId: string };

export interface WorkspaceTab {
  readonly id: string;
  readonly view: WorkspaceTabView;
  readonly lastActivatedAt: number;
}

/**
 * Background tabs stay fully mounted ("완전 생존"), so each one keeps paying
 * render and memory cost. The cap keeps that spend bounded; opening past it
 * is refused with guidance rather than silently evicting someone's tab.
 */
export const MAX_WORKSPACE_TABS = 10;

export function workspaceTabViewKey(view: WorkspaceTabView): string {
  switch (view.kind) {
    case "thread":
      return `thread:${view.environmentId}:${view.threadId}`;
    case "draft":
      return `draft:${view.draftId}`;
    case "control-center":
      return `control-center:${view.environmentId}:${view.projectId}`;
  }
}

function makeTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface WorkspaceTabState {
  readonly tabs: ReadonlyArray<WorkspaceTab>;
  readonly activeTabId: string | null;
  /**
   * Route → tabs sync. Called by the (thin) route components: makes the
   * active tab show `view`. If another tab already shows it, that tab becomes
   * active instead — one screen never lives in two tabs at once.
   */
  readonly syncRouteView: (view: WorkspaceTabView) => void;
  /** Open `view` in a background tab. Returns false when the cap refuses it. */
  readonly openBackgroundTab: (view: WorkspaceTabView) => boolean;
  readonly activateTab: (tabId: string) => void;
  /** Returns the tab to navigate to next (the neighbor), if any. */
  readonly closeTab: (tabId: string) => WorkspaceTab | null;
  readonly closeTabsForView: (viewKey: string) => void;
  readonly moveTab: (fromIndex: number, toIndex: number) => void;
  /**
   * A background tab's screen changed identity without navigation — a draft
   * that got promoted to a server thread keeps its tab.
   */
  readonly retargetTabView: (fromViewKey: string, view: WorkspaceTabView) => void;
  /** Completion badges: the newest turn the person has already seen per tab. */
  readonly seenTurnByTabId: Readonly<Record<string, string>>;
  readonly markTurnSeen: (tabId: string, turnId: string) => void;
}

export const useWorkspaceTabStore = create<WorkspaceTabState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,

      syncRouteView: (view) => {
        const key = workspaceTabViewKey(view);
        const { tabs, activeTabId } = get();
        const existing = tabs.find((tab) => workspaceTabViewKey(tab.view) === key);
        if (existing) {
          if (existing.id === activeTabId && existing.view === view) return;
          set({
            activeTabId: existing.id,
            tabs: tabs.map((tab) =>
              tab.id === existing.id ? { ...tab, view, lastActivatedAt: Date.now() } : tab,
            ),
          });
          return;
        }
        const active = tabs.find((tab) => tab.id === activeTabId);
        if (active) {
          // Plain navigation retargets the current tab, the way a browser
          // click navigates the page you are on.
          set({
            tabs: tabs.map((tab) =>
              tab.id === active.id ? { ...tab, view, lastActivatedAt: Date.now() } : tab,
            ),
          });
          return;
        }
        const tab: WorkspaceTab = { id: makeTabId(), view, lastActivatedAt: Date.now() };
        set({ tabs: [...tabs, tab], activeTabId: tab.id });
      },

      openBackgroundTab: (view) => {
        const key = workspaceTabViewKey(view);
        const { tabs } = get();
        if (tabs.some((tab) => workspaceTabViewKey(tab.view) === key)) {
          return true;
        }
        if (tabs.length >= MAX_WORKSPACE_TABS) {
          return false;
        }
        const tab: WorkspaceTab = { id: makeTabId(), view, lastActivatedAt: 0 };
        set({ tabs: [...tabs, tab] });
        return true;
      },

      activateTab: (tabId) => {
        const { tabs } = get();
        if (!tabs.some((tab) => tab.id === tabId)) return;
        set({
          activeTabId: tabId,
          tabs: tabs.map((tab) =>
            tab.id === tabId ? { ...tab, lastActivatedAt: Date.now() } : tab,
          ),
        });
      },

      closeTab: (tabId) => {
        const { tabs, activeTabId } = get();
        const index = tabs.findIndex((tab) => tab.id === tabId);
        if (index === -1) return null;
        const nextTabs = tabs.filter((tab) => tab.id !== tabId);
        // Closing the active tab hands focus to the right neighbor, then the
        // left one — the browser convention.
        const nextActive =
          tabId === activeTabId ? (nextTabs[index] ?? nextTabs[index - 1] ?? null) : null;
        set({
          tabs: nextTabs,
          activeTabId: tabId === activeTabId ? (nextActive?.id ?? null) : activeTabId,
        });
        return nextActive;
      },

      closeTabsForView: (viewKey) => {
        const { tabs, activeTabId } = get();
        const nextTabs = tabs.filter((tab) => workspaceTabViewKey(tab.view) !== viewKey);
        if (nextTabs.length === tabs.length) return;
        const activeSurvives = nextTabs.some((tab) => tab.id === activeTabId);
        set({
          tabs: nextTabs,
          activeTabId: activeSurvives ? activeTabId : (nextTabs.at(-1)?.id ?? null),
        });
      },

      moveTab: (fromIndex, toIndex) => {
        const { tabs } = get();
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= tabs.length ||
          toIndex >= tabs.length
        ) {
          return;
        }
        const next = [...tabs];
        const [moved] = next.splice(fromIndex, 1);
        if (!moved) return;
        next.splice(toIndex, 0, moved);
        set({ tabs: next });
      },

      retargetTabView: (fromViewKey, view) => {
        const { tabs } = get();
        if (!tabs.some((tab) => workspaceTabViewKey(tab.view) === fromViewKey)) return;
        set({
          tabs: tabs.map((tab) =>
            workspaceTabViewKey(tab.view) === fromViewKey ? { ...tab, view } : tab,
          ),
        });
      },

      seenTurnByTabId: {},
      markTurnSeen: (tabId, turnId) => {
        const { seenTurnByTabId } = get();
        if (seenTurnByTabId[tabId] === turnId) return;
        set({ seenTurnByTabId: { ...seenTurnByTabId, [tabId]: turnId } });
      },
    }),
    {
      name: "t3.workspace-tabs.v1",
      partialize: (state) => ({ tabs: state.tabs, activeTabId: state.activeTabId }),
    },
  ),
);

export function useWorkspaceTabs(): ReadonlyArray<WorkspaceTab> {
  return useWorkspaceTabStore(useShallow((state) => state.tabs));
}

export function useActiveWorkspaceTabId(): string | null {
  return useWorkspaceTabStore((state) => state.activeTabId);
}
