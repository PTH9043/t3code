import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_WORKSPACE_TABS,
  useWorkspaceTabStore,
  workspaceTabViewKey,
  type WorkspaceTabView,
} from "./workspaceTabStore";

const threadView = (threadId: string): WorkspaceTabView => ({
  kind: "thread",
  environmentId: "env-1",
  threadId,
});

function resetStore() {
  useWorkspaceTabStore.setState({ tabs: [], activeTabId: null, seenTurnByTabId: {} });
}

describe("workspaceTabStore", () => {
  beforeEach(resetStore);

  it("creates a tab on first navigation and retargets it on the next", () => {
    const store = useWorkspaceTabStore.getState();
    store.syncRouteView(threadView("thread-a"));
    let state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);

    // Plain navigation retargets the current tab instead of opening another.
    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-b"));
    state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.view).toEqual(threadView("thread-b"));
  });

  it("activates the existing tab when the view is already open elsewhere", () => {
    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-a"));
    const firstTabId = useWorkspaceTabStore.getState().activeTabId;
    useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-b"));

    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-b"));
    const state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).not.toBe(firstTabId);
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.view).toEqual(
      threadView("thread-b"),
    );
    // The first tab kept its own screen.
    expect(state.tabs.find((tab) => tab.id === firstTabId)?.view).toEqual(threadView("thread-a"));
  });

  it("refuses a background tab past the cap and dedupes existing views", () => {
    const store = useWorkspaceTabStore.getState();
    for (let index = 0; index < MAX_WORKSPACE_TABS; index += 1) {
      expect(store.openBackgroundTab(threadView(`thread-${index}`))).toBe(true);
    }
    expect(useWorkspaceTabStore.getState().tabs).toHaveLength(MAX_WORKSPACE_TABS);
    expect(useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-extra"))).toBe(
      false,
    );
    // Reopening an already-open view is a no-op success, not a new tab.
    expect(useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-0"))).toBe(true);
    expect(useWorkspaceTabStore.getState().tabs).toHaveLength(MAX_WORKSPACE_TABS);
  });

  it("hands focus to the right neighbor when closing the active tab", () => {
    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-a"));
    useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-b"));
    useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-c"));
    const [first, second, third] = useWorkspaceTabStore.getState().tabs;
    if (!first || !second || !third) throw new Error("expected three tabs");

    const next = useWorkspaceTabStore.getState().closeTab(first.id);
    expect(next?.id).toBe(second.id);
    expect(useWorkspaceTabStore.getState().activeTabId).toBe(second.id);

    // Closing a background tab never steals focus.
    const nothing = useWorkspaceTabStore.getState().closeTab(third.id);
    expect(nothing).toBeNull();
    expect(useWorkspaceTabStore.getState().activeTabId).toBe(second.id);
  });

  it("reorders with moveTab and survives a view retarget", () => {
    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-a"));
    useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-b"));
    useWorkspaceTabStore.getState().moveTab(0, 1);
    expect(useWorkspaceTabStore.getState().tabs.map((tab) => tab.view)).toEqual([
      threadView("thread-b"),
      threadView("thread-a"),
    ]);

    useWorkspaceTabStore
      .getState()
      .retargetTabView(workspaceTabViewKey(threadView("thread-b")), threadView("thread-z"));
    expect(useWorkspaceTabStore.getState().tabs[0]?.view).toEqual(threadView("thread-z"));
  });

  it("opens a new tab when navigation crosses a folder boundary", () => {
    useWorkspaceTabStore
      .getState()
      .syncRouteView(threadView("thread-a"), { projectKey: "env-1:folder-a" });
    const firstTabId = useWorkspaceTabStore.getState().activeTabId;

    useWorkspaceTabStore
      .getState()
      .syncRouteView(threadView("thread-b"), { projectKey: "env-1:folder-b" });
    let state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(2);
    // The tab the person was on survived, showing what it showed.
    expect(state.tabs.find((tab) => tab.id === firstTabId)?.view).toEqual(threadView("thread-a"));
    expect(state.activeTabId).not.toBe(firstTabId);

    // Back into folder-a: its existing tab is reused, not a third tab.
    useWorkspaceTabStore
      .getState()
      .syncRouteView(threadView("thread-a2"), { projectKey: "env-1:folder-a" });
    state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(firstTabId);
    expect(state.tabs.find((tab) => tab.id === firstTabId)?.view).toEqual(threadView("thread-a2"));
  });

  it("stays in the tab for same-folder or unknown-folder navigation", () => {
    useWorkspaceTabStore
      .getState()
      .syncRouteView(threadView("thread-a"), { projectKey: "env-1:folder-a" });
    const tabId = useWorkspaceTabStore.getState().activeTabId;

    useWorkspaceTabStore
      .getState()
      .syncRouteView(threadView("thread-a2"), { projectKey: "env-1:folder-a" });
    expect(useWorkspaceTabStore.getState().tabs).toHaveLength(1);

    // A screen whose folder is not known yet must not spawn tabs.
    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-x"));
    const state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(tabId);
  });

  it("falls back to retargeting at the cap instead of losing the navigation", () => {
    for (let index = 0; index < MAX_WORKSPACE_TABS; index += 1) {
      useWorkspaceTabStore
        .getState()
        .openBackgroundTab(threadView(`thread-${index}`), { projectKey: `env-1:folder-${index}` });
    }
    useWorkspaceTabStore.getState().activateTab(useWorkspaceTabStore.getState().tabs[0]!.id);
    const activeTabId = useWorkspaceTabStore.getState().activeTabId;

    useWorkspaceTabStore
      .getState()
      .syncRouteView(threadView("thread-new"), { projectKey: "env-1:folder-new" });
    const state = useWorkspaceTabStore.getState();
    expect(state.tabs).toHaveLength(MAX_WORKSPACE_TABS);
    expect(state.activeTabId).toBe(activeTabId);
    expect(state.tabs.find((tab) => tab.id === activeTabId)?.view).toEqual(
      threadView("thread-new"),
    );
  });

  it("drops every tab that shows a deleted view", () => {
    useWorkspaceTabStore.getState().syncRouteView(threadView("thread-a"));
    useWorkspaceTabStore.getState().openBackgroundTab(threadView("thread-b"));
    useWorkspaceTabStore.getState().closeTabsForView(workspaceTabViewKey(threadView("thread-a")));
    const state = useWorkspaceTabStore.getState();
    expect(state.tabs.map((tab) => tab.view)).toEqual([threadView("thread-b")]);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
  });
});
