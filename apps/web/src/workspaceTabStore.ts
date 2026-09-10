import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "./env";

/**
 * One workspace tab = the screen it is showing. "자유 단위": a tab can hold
 * any thread, draft composer, or a project's control center — whatever the
 * person last navigated it to, the way a browser tab holds its last page.
 */
export type WorkspaceTabView =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "control-center"; readonly environmentId: string; readonly projectId: string };

/** The conversation-shaped views — everything a "대화로 돌아가기" can return to. */
export type ChatWorkspaceTabView = Extract<
  WorkspaceTabView,
  { kind: "thread" } | { kind: "draft" }
>;

export interface WorkspaceTab {
  readonly id: string;
  readonly view: WorkspaceTabView;
  readonly lastActivatedAt: number;
  /**
   * The folder this tab is working in (`environmentId:projectId`), null until
   * the screen's project is known. Navigation that crosses this boundary
   * opens a new tab instead of retargeting — a tab is a folder workspace the
   * person set up, not just a page.
   */
  readonly projectKey: string | null;
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
  /** Most recent conversation for global screens such as settings and the overview. */
  readonly lastChatView: ChatWorkspaceTabView | null;
  /** Project control centers return within their own environment and folder. */
  readonly lastChatViewByProjectKey: Readonly<Record<string, ChatWorkspaceTabView>>;
  /**
   * Route → tabs sync. Called by the (thin) route components: shows `view`
   * in the right tab. Same-folder navigation retargets the current tab; a
   * view already open elsewhere activates that tab; and navigation into a
   * DIFFERENT folder reuses that folder's tab or opens a new one, so the tab
   * the person was on survives (folder-per-tab). Past the cap it falls back
   * to retargeting rather than losing the navigation.
   */
  readonly syncRouteView: (
    view: WorkspaceTabView,
    options?: { readonly projectKey?: string | null },
  ) => void;
  /** Open `view` in a background tab. Returns false when the cap refuses it. */
  readonly openBackgroundTab: (
    view: WorkspaceTabView,
    options?: { readonly projectKey?: string | null },
  ) => boolean;
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
      lastChatView: null,
      lastChatViewByProjectKey: {},

      syncRouteView: (view, options) => {
        const key = workspaceTabViewKey(view);
        const projectKey = options?.projectKey ?? null;
        const { tabs, activeTabId, lastChatView, lastChatViewByProjectKey } = get();
        if (view.kind !== "control-center") {
          // Recorded before the tab bookkeeping below, which has early
          // returns for navigation that leaves the tabs untouched.
          const rememberGlobal = lastChatView === null || workspaceTabViewKey(lastChatView) !== key;
          // Project identity can arrive after the route, even when the view
          // has not changed. Never infer it from the previously active tab.
          const projectView =
            projectKey === null ? undefined : lastChatViewByProjectKey[projectKey];
          const rememberProject =
            projectKey !== null &&
            (projectView === undefined || workspaceTabViewKey(projectView) !== key);
          if (rememberGlobal || rememberProject) {
            set({
              ...(rememberGlobal ? { lastChatView: view } : {}),
              ...(rememberProject
                ? { lastChatViewByProjectKey: { ...lastChatViewByProjectKey, [projectKey]: view } }
                : {}),
            });
          }
        }
        const retarget = (tabId: string, activate: boolean) =>
          set({
            ...(activate ? { activeTabId: tabId } : {}),
            tabs: tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    view,
                    lastActivatedAt: Date.now(),
                    projectKey: projectKey ?? tab.projectKey,
                  }
                : tab,
            ),
          });

        const existing = tabs.find((tab) => workspaceTabViewKey(tab.view) === key);
        if (existing) {
          if (
            existing.id === activeTabId &&
            existing.view === view &&
            (projectKey === null || existing.projectKey === projectKey)
          ) {
            return;
          }
          retarget(existing.id, true);
          return;
        }
        const active = tabs.find((tab) => tab.id === activeTabId);
        if (!active) {
          const tab: WorkspaceTab = {
            id: makeTabId(),
            view,
            lastActivatedAt: Date.now(),
            projectKey,
          };
          set({ tabs: [...tabs, tab], activeTabId: tab.id });
          return;
        }
        const sameFolder =
          projectKey === null || active.projectKey === null || active.projectKey === projectKey;
        if (sameFolder) {
          // Same-folder navigation stays in the tab, the way a browser click
          // navigates the page you are on.
          retarget(active.id, false);
          return;
        }
        // Crossing a folder boundary must not eat the tab the person was on:
        // reuse the most recent tab already working in that folder, or open a
        // new one. Only the cap forces a retarget.
        const folderTab = tabs
          .filter((tab) => tab.projectKey === projectKey)
          .sort((left, right) => right.lastActivatedAt - left.lastActivatedAt)[0];
        if (folderTab) {
          retarget(folderTab.id, true);
          return;
        }
        if (tabs.length >= MAX_WORKSPACE_TABS) {
          retarget(active.id, false);
          return;
        }
        const tab: WorkspaceTab = {
          id: makeTabId(),
          view,
          lastActivatedAt: Date.now(),
          projectKey,
        };
        set({ tabs: [...tabs, tab], activeTabId: tab.id });
      },

      openBackgroundTab: (view, options) => {
        const key = workspaceTabViewKey(view);
        const { tabs } = get();
        if (tabs.some((tab) => workspaceTabViewKey(tab.view) === key)) {
          return true;
        }
        if (tabs.length >= MAX_WORKSPACE_TABS) {
          return false;
        }
        const tab: WorkspaceTab = {
          id: makeTabId(),
          view,
          lastActivatedAt: 0,
          projectKey: options?.projectKey ?? null,
        };
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
        const { tabs, activeTabId, lastChatView, lastChatViewByProjectKey } = get();
        const nextTabs = tabs.filter((tab) => workspaceTabViewKey(tab.view) !== viewKey);
        const nextProjectViews = Object.fromEntries(
          Object.entries(lastChatViewByProjectKey).filter(
            ([, view]) => workspaceTabViewKey(view) !== viewKey,
          ),
        );
        const forgetLastChat =
          lastChatView !== null && workspaceTabViewKey(lastChatView) === viewKey;
        if (
          nextTabs.length === tabs.length &&
          !forgetLastChat &&
          Object.keys(nextProjectViews).length === Object.keys(lastChatViewByProjectKey).length
        ) {
          return;
        }
        const activeSurvives = nextTabs.some((tab) => tab.id === activeTabId);
        set({
          tabs: nextTabs,
          activeTabId:
            nextTabs.length === tabs.length || activeSurvives
              ? activeTabId
              : (nextTabs.at(-1)?.id ?? null),
          // This runs when the screen itself is gone (deleted thread, dropped
          // draft), so it must stop being the conversation to go back to.
          ...(forgetLastChat ? { lastChatView: null } : {}),
          lastChatViewByProjectKey: nextProjectViews,
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
        const { tabs, lastChatView, lastChatViewByProjectKey } = get();
        const matches = (candidate: WorkspaceTabView) =>
          workspaceTabViewKey(candidate) === fromViewKey;
        if (
          !tabs.some((tab) => matches(tab.view)) &&
          !(lastChatView !== null && matches(lastChatView)) &&
          !Object.values(lastChatViewByProjectKey).some(matches)
        ) {
          return;
        }
        set({
          tabs: tabs.map((tab) =>
            workspaceTabViewKey(tab.view) === fromViewKey ? { ...tab, view } : tab,
          ),
          // A promoted draft keeps its tab; it keeps its place as the
          // conversation to go back to under the new identity too.
          ...(view.kind !== "control-center" &&
          lastChatView !== null &&
          workspaceTabViewKey(lastChatView) === fromViewKey
            ? { lastChatView: view }
            : {}),
          ...(view.kind !== "control-center"
            ? {
                lastChatViewByProjectKey: Object.fromEntries(
                  Object.entries(lastChatViewByProjectKey).map(([projectKey, previous]) => [
                    projectKey,
                    matches(previous) ? view : previous,
                  ]),
                ),
              }
            : {}),
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
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        lastChatView: state.lastChatView,
        lastChatViewByProjectKey: state.lastChatViewByProjectKey,
      }),
      // Tabs persisted before projectKey existed rehydrate with it undefined;
      // normalize to null so folder-boundary checks stay two-valued.
      merge: (persisted, current) => {
        const stored = persisted as
          | {
              tabs?: ReadonlyArray<WorkspaceTab>;
              activeTabId?: string | null;
              lastChatView?: ChatWorkspaceTabView | null;
              lastChatViewByProjectKey?: Readonly<Record<string, ChatWorkspaceTabView>>;
            }
          | undefined;
        return {
          ...current,
          tabs: (stored?.tabs ?? []).map((tab) => ({
            ...tab,
            projectKey: tab.projectKey ?? null,
          })),
          activeTabId: stored?.activeTabId ?? null,
          lastChatView: stored?.lastChatView ?? null,
          lastChatViewByProjectKey: stored?.lastChatViewByProjectKey ?? {},
        };
      },
    },
  ),
);

export function useWorkspaceTabs(): ReadonlyArray<WorkspaceTab> {
  return useWorkspaceTabStore(useShallow((state) => state.tabs));
}

export function useActiveWorkspaceTabId(): string | null {
  return useWorkspaceTabStore((state) => state.activeTabId);
}

/**
 * Whether this page load started on the index route. Read at module load,
 * before any navigation, so a later trip to the index (closing the last tab,
 * a deleted screen) is not mistaken for a cold start. Electron routes off the
 * hash; the browser off the path.
 */
const bootedAtIndex =
  typeof window === "undefined"
    ? false
    : (isElectron ? window.location.hash.replace(/^#/, "") || "/" : window.location.pathname) ===
      "/";

let startupRestoreTaken = false;

/**
 * The screen this window was on when it last closed, taken once per page
 * load. Electron opens the app at a bare origin and the router boots at the
 * index, which is a "start something new" landing, not a resume — without
 * this every launch and every reload drops the person into a fresh draft.
 * Consumed on first read so a screen that no longer exists falls through to
 * that landing instead of bouncing against it.
 */
export function takeStartupRestoreView(): WorkspaceTabView | null {
  if (startupRestoreTaken || !bootedAtIndex) return null;
  startupRestoreTaken = true;
  return selectStartupRestoreView(useWorkspaceTabStore.getState());
}

/** The tab the window was left on, or the conversation behind it. */
export function selectStartupRestoreView(state: {
  readonly tabs: ReadonlyArray<WorkspaceTab>;
  readonly activeTabId: string | null;
  readonly lastChatView: ChatWorkspaceTabView | null;
}): WorkspaceTabView | null {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  return activeTab?.view ?? state.lastChatView;
}
