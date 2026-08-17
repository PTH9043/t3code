import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MEETING_COMPOSER_CONFIG,
  meetingSeatId,
  readMeetingComposerConfig,
  toggleMeetingComposerSeat,
  updateMeetingComposerConfig,
  useMeetingComposerStore,
  type MeetingComposerSeat,
} from "./meetingComposerStore";
import { useWorkspaceTabStore, type WorkspaceTab } from "./workspaceTabStore";

function seat(instanceId: string, displayName: string): MeetingComposerSeat {
  return {
    id: meetingSeatId(instanceId),
    instanceId: ProviderInstanceId.make(instanceId),
    model: "model-x",
    displayName,
  };
}

function tab(id: string): WorkspaceTab {
  return {
    id,
    view: { kind: "thread", environmentId: "env-1", threadId: `thread-${id}` },
    lastActivatedAt: 0,
    projectKey: null,
  };
}

function activateTab(id: string) {
  useWorkspaceTabStore.setState((state) => ({
    tabs: state.tabs.some((entry) => entry.id === id) ? state.tabs : [...state.tabs, tab(id)],
    activeTabId: id,
  }));
}

beforeEach(() => {
  useMeetingComposerStore.setState({ configsByTabId: {} });
  useWorkspaceTabStore.setState({ tabs: [tab("tab-1")], activeTabId: "tab-1" });
});

describe("meetingComposerStore", () => {
  it("starts from the disabled default", () => {
    expect(readMeetingComposerConfig()).toEqual(DEFAULT_MEETING_COMPOSER_CONFIG);
  });

  it("toggles seats on and off", () => {
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    toggleMeetingComposerSeat(seat("codex-a", "Codex"));
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual([
      "claude-a",
      "codex-a",
    ]);
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["codex-a"]);
  });

  it("drops the chair back to automatic election when its seat leaves the table", () => {
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    toggleMeetingComposerSeat(seat("codex-a", "Codex"));
    updateMeetingComposerConfig((config) => ({ ...config, chairSeatId: "codex-a" }));
    toggleMeetingComposerSeat(seat("codex-a", "Codex"));
    expect(readMeetingComposerConfig().chairSeatId).toBeNull();
  });

  it("refuses a ninth seat instead of failing at send", () => {
    for (let index = 0; index < 9; index += 1) {
      toggleMeetingComposerSeat(seat(`seat-${index}`, `Seat ${index}`));
    }
    expect(readMeetingComposerConfig().seats).toHaveLength(8);
  });

  it("keeps each tab's meeting room to itself", () => {
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));

    // Another tab: pristine config, arming it touches only that tab.
    activateTab("tab-2");
    expect(readMeetingComposerConfig()).toEqual(DEFAULT_MEETING_COMPOSER_CONFIG);
    toggleMeetingComposerSeat(seat("codex-a", "Codex"));

    // Back on the first tab: its armed roster is exactly as it was left.
    activateTab("tab-1");
    expect(readMeetingComposerConfig().enabled).toBe(true);
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["claude-a"]);
  });

  it("takes a closed tab's meeting room with it", () => {
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    activateTab("tab-2");
    updateMeetingComposerConfig((config) => ({ ...config, maxRounds: 5 }));

    // Closing tab-1 drops its config; tab-2 keeps its own.
    useWorkspaceTabStore.setState((state) => ({
      tabs: state.tabs.filter((entry) => entry.id !== "tab-1"),
    }));
    expect(useMeetingComposerStore.getState().configsByTabId["tab-1"]).toBeUndefined();
    expect(readMeetingComposerConfig().maxRounds).toBe(5);
  });

  it("screens seat ids into the server's participant-id shape", () => {
    // Instance ids are slugs already; the screen only has to catch the
    // exceptional one that is not.
    expect(meetingSeatId("codex-a")).toBe("codex-a");
    expect(meetingSeatId("계정@main")).toBe("main");
    expect(meetingSeatId("---")).toBe("seat");
    expect(meetingSeatId("a".repeat(80))).toHaveLength(64);
  });
});
