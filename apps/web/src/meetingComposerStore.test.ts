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

function tab(id: string, folderKey: string | null): WorkspaceTab {
  return {
    id,
    view: { kind: "thread", environmentId: "env-1", threadId: `thread-${id}` },
    lastActivatedAt: 0,
    projectKey: folderKey,
  };
}

function showFolder(tabId: string, folderKey: string | null) {
  useWorkspaceTabStore.setState((state) => ({
    tabs: state.tabs.some((entry) => entry.id === tabId)
      ? state.tabs
      : [...state.tabs, tab(tabId, folderKey)],
    activeTabId: tabId,
  }));
}

beforeEach(() => {
  useMeetingComposerStore.setState({ configsByFolder: {} });
  useWorkspaceTabStore.setState({ tabs: [tab("tab-1", "env-1:folder-a")], activeTabId: "tab-1" });
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

  it("keeps each folder's meeting room to itself", () => {
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));

    // Another folder: pristine config, arming it touches only that folder.
    showFolder("tab-2", "env-1:folder-b");
    expect(readMeetingComposerConfig()).toEqual(DEFAULT_MEETING_COMPOSER_CONFIG);
    toggleMeetingComposerSeat(seat("codex-a", "Codex"));

    // Back in folder-a: its armed roster is exactly as it was left.
    showFolder("tab-1", "env-1:folder-a");
    expect(readMeetingComposerConfig().enabled).toBe(true);
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["claude-a"]);
  });

  it("survives the tab closing and the folder reopening in a fresh tab", () => {
    // The regression that kept biting: settings keyed to a tab id died with
    // the tab. The folder is the identity that survives.
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));

    useWorkspaceTabStore.setState({ tabs: [], activeTabId: null });
    showFolder("tab-99", "env-1:folder-a");

    expect(readMeetingComposerConfig().enabled).toBe(true);
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["claude-a"]);
  });

  it("keeps the meeting's rounds when switching styles back and forth", () => {
    updateMeetingComposerConfig((config) => ({ ...config, maxRounds: 5 }));
    updateMeetingComposerConfig((config) => ({ ...config, style: "collaboration" }));
    expect(readMeetingComposerConfig().style).toBe("collaboration");
    expect(readMeetingComposerConfig().maxRounds).toBe(5);
    updateMeetingComposerConfig((config) => ({ ...config, style: "meeting" }));
    expect(readMeetingComposerConfig().style).toBe("meeting");
    expect(readMeetingComposerConfig().maxRounds).toBe(5);
  });

  it("folds a legacy zero-round entry into the collaboration style", () => {
    // The first cut of 협업 was persisted as maxRounds 0 with no style field;
    // it must read back as style=collaboration with the meeting rounds
    // restored to the default.
    const { style: _legacyHadNoStyle, ...legacyEntry } = {
      ...DEFAULT_MEETING_COMPOSER_CONFIG,
      enabled: true,
      maxRounds: 0,
    };
    useMeetingComposerStore.setState({
      configsByFolder: { "env-1:folder-a": legacyEntry as never },
    });
    const config = readMeetingComposerConfig();
    expect(config.style).toBe("collaboration");
    expect(config.maxRounds).toBe(DEFAULT_MEETING_COMPOSER_CONFIG.maxRounds);
    expect(config.enabled).toBe(true);
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
