import { ProviderInstanceId } from "@t3tools/contracts";
import { shallow } from "zustand/shallow";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MEETING_COMPOSER_CONFIG,
  activeMeetingConversationKey,
  addMeetingComposerSeat,
  disarmMeetingComposer,
  meetingSeatId,
  configFromExecutionProfile,
  meetingSetupFromConfig,
  promoteMeetingComposerConfig,
  readMeetingComposerConfig,
  setMeetingComposerSeatModel,
  setMeetingComposerSeatOption,
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
  it("keeps a restored legacy room snapshot shallow-stable before new settings are saved", () => {
    const { verificationCommands: _oldCommands, ...legacy } = DEFAULT_MEETING_COMPOSER_CONFIG;
    useMeetingComposerStore.setState({ configsByFolder: { "env-1:folder-a": legacy } });
    const first = readMeetingComposerConfig();
    const second = readMeetingComposerConfig();
    expect(first.verificationCommands).toBe(second.verificationCommands);
    expect(shallow(first, second)).toBe(true);
  });
  it("reuses a profile's roster and effort without leaking into another folder", () => {
    const config = {
      ...DEFAULT_MEETING_COMPOSER_CONFIG,
      seats: [
        seat("codex", "Implementer"),
        { ...seat("claude", "Reviewer"), options: [{ id: "reasoningEffort", value: "high" }] },
      ],
      maxParallel: 2,
      isolateWorktrees: true,
    };
    const profile = {
      id: "focused",
      name: "Focused fix",
      revision: 2,
      instructions: "Keep scope small",
      verificationCommands: ["vp test run"],
      meeting: meetingSetupFromConfig(config),
      orchestra: { maxParallel: 2, isolateWorktrees: true },
    };
    updateMeetingComposerConfig((current) => configFromExecutionProfile(current, profile));
    expect(readMeetingComposerConfig()).toMatchObject({
      enabled: true,
      maxParallel: 2,
      isolateWorktrees: true,
      executionProfile: profile,
    });
    expect(readMeetingComposerConfig().seats[1]?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    showFolder("tab-2", "env-1:folder-b");
    expect(readMeetingComposerConfig().seats).toEqual([]);
    expect(readMeetingComposerConfig().executionProfile).toBeUndefined();
  });
  it("keeps multiple models on one account independent while preserving the chosen conductor", () => {
    addMeetingComposerSeat({ ...seat("codex", "Codex"), model: "model-a" });
    addMeetingComposerSeat({ ...seat("codex", "Codex"), model: "model-b" });
    addMeetingComposerSeat({ ...seat("claude", "Claude"), model: "model-c" });
    const [first, second, chair] = readMeetingComposerConfig().seats;
    expect(new Set([first!.id, second!.id, chair!.id]).size).toBe(3);
    updateMeetingComposerConfig((config) => ({ ...config, chairSeatId: chair!.id }));
    setMeetingComposerSeatOption(first!.id, "reasoningEffort", "low");
    setMeetingComposerSeatOption(second!.id, "reasoningEffort", "high");
    expect(readMeetingComposerConfig().seats[0]!.options).toEqual([
      { id: "reasoningEffort", value: "low" },
    ]);
    expect(readMeetingComposerConfig().seats[1]!.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    toggleMeetingComposerSeat(first!);
    expect(readMeetingComposerConfig().seats.map((entry) => entry.model)).toEqual([
      "model-b",
      "model-c",
    ]);
    expect(readMeetingComposerConfig().chairSeatId).toBe(chair!.id);
  });

  it("replaces the previous worker limit when switching execution profiles", () => {
    const limited = {
      id: "limited",
      name: "Limited",
      revision: 1,
      instructions: "",
      verificationCommands: [],
      meeting: meetingSetupFromConfig(DEFAULT_MEETING_COMPOSER_CONFIG),
      orchestra: { maxParallel: 1, isolateWorktrees: false, maxWorkerTurns: 3 },
    };
    const unlimited = {
      ...limited,
      id: "unlimited",
      orchestra: { maxParallel: 1, isolateWorktrees: false },
    };
    updateMeetingComposerConfig((config) => configFromExecutionProfile(config, limited));
    expect(readMeetingComposerConfig().maxWorkerTurns).toBe(3);
    updateMeetingComposerConfig((config) => configFromExecutionProfile(config, unlimited));
    expect(readMeetingComposerConfig().maxWorkerTurns).toBeUndefined();
    expect(Object.hasOwn(readMeetingComposerConfig(), "maxWorkerTurns")).toBe(false);
    expect(readMeetingComposerConfig().executionProfile?.id).toBe("unlimited");
    updateMeetingComposerConfig((config) => configFromExecutionProfile(config, limited));
    expect(readMeetingComposerConfig().maxWorkerTurns).toBe(3);
  });

  it("keeps the execution mode and supervisor separately for conversations in the same folder", () => {
    updateMeetingComposerConfig((config) => ({
      ...config,
      executionMode: "persistent",
      chairSeatId: "supervisor-a",
      seats: [{ ...seat("codex", "Supervisor A"), id: "supervisor-a" }],
    }));
    showFolder("tab-2", "env-1:folder-a");
    expect(readMeetingComposerConfig().executionMode).toBe("once");
    expect(readMeetingComposerConfig().chairSeatId).toBeNull();
    updateMeetingComposerConfig((config) => ({ ...config, chairSeatId: "supervisor-b" }));
    showFolder("tab-1", "env-1:folder-a");
    expect(readMeetingComposerConfig()).toMatchObject({
      executionMode: "persistent",
      chairSeatId: "supervisor-a",
    });
  });

  it("preserves user-assigned roles in the run roster", () => {
    const config = {
      ...DEFAULT_MEETING_COMPOSER_CONFIG,
      allowAdditionalWorkers: true,
      seats: [{ ...seat("claude", "Supervisor"), roleDescription: "개발 방향" }],
    };
    expect(meetingSetupFromConfig(config).participants[0]?.roleDescription).toBe("개발 방향");
    expect(meetingSetupFromConfig(config).allowAdditionalWorkers).toBe(false);
  });

  it("keeps duplicate account-model seats independent and clears changed model options", () => {
    addMeetingComposerSeat({ ...seat("codex", "Codex"), model: "model-a" });
    addMeetingComposerSeat({ ...seat("codex", "Codex"), model: "model-b" });
    addMeetingComposerSeat({ ...seat("codex", "Codex"), model: "model-a" });
    const first = readMeetingComposerConfig().seats[0]!;
    setMeetingComposerSeatOption(first.id, "reasoningEffort", "high");
    setMeetingComposerSeatModel(first.id, "model-b");
    expect(readMeetingComposerConfig().seats).toHaveLength(3);
    expect(readMeetingComposerConfig().seats[0]!.model).toBe("model-b");
    setMeetingComposerSeatModel(first.id, "model-c");
    expect(readMeetingComposerConfig().seats[0]).toMatchObject({
      id: first.id,
      model: "model-c",
      options: [],
    });
  });

  it("starts new rooms with bounded direct execution without overwriting saved preferences", () => {
    expect(readMeetingComposerConfig()).toMatchObject({
      style: "collaboration",
      maxRevisions: 1,
      allowAdditionalWorkers: false,
    });
    updateMeetingComposerConfig((config) => ({
      ...config,
      style: "meeting",
      maxRevisions: 4,
      allowAdditionalWorkers: true,
    }));
    expect(readMeetingComposerConfig()).toMatchObject({
      style: "meeting",
      maxRevisions: 4,
      allowAdditionalWorkers: true,
    });
  });

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

  it("preserves more than eight independently selected seats", () => {
    for (let index = 0; index < 9; index += 1) {
      toggleMeetingComposerSeat(seat(`seat-${index}`, `Seat ${index}`));
    }
    expect(readMeetingComposerConfig().seats).toHaveLength(9);
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

  it("survives reopening the same conversation in a fresh tab", () => {
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));

    useWorkspaceTabStore.setState({ tabs: [], activeTabId: null });
    useWorkspaceTabStore.setState({
      tabs: [{ ...tab("tab-99", "env-1:folder-a"), view: tab("tab-1", "env-1:folder-a").view }],
      activeTabId: "tab-99",
    });

    expect(readMeetingComposerConfig().enabled).toBe(true);
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["claude-a"]);
  });

  it("keeps settings independent for conversations in the same folder", () => {
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    showFolder("tab-2", "env-1:folder-a");
    expect(readMeetingComposerConfig()).toEqual(DEFAULT_MEETING_COMPOSER_CONFIG);
    toggleMeetingComposerSeat(seat("codex-a", "Codex"));
    showFolder("tab-1", "env-1:folder-a");
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["claude-a"]);
    expect(readMeetingComposerConfig().enabled).toBe(true);
  });

  it("disarms only the conversation that started a run and retains its roster", () => {
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    const first = activeMeetingConversationKey();
    showFolder("tab-2", "env-1:folder-a");
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    disarmMeetingComposer(first);
    expect(readMeetingComposerConfig().enabled).toBe(true);
    showFolder("tab-1", "env-1:folder-a");
    expect(readMeetingComposerConfig().enabled).toBe(false);
    expect(readMeetingComposerConfig().seats.map((entry) => entry.id)).toEqual(["claude-a"]);
  });

  it("preserves the draft roster when it becomes a conversation without rearming it", () => {
    useMeetingComposerStore.getState().updateConfig("draft:sample", (config) => ({
      ...config,
      enabled: true,
      seats: [seat("claude", "Supervisor")],
    }));
    promoteMeetingComposerConfig("draft:sample", "thread:env-1:new");
    const promoted = useMeetingComposerStore.getState().configsByFolder["thread:env-1:new"];
    expect(promoted?.enabled).toBe(false);
    expect(promoted?.seats[0]?.displayName).toBe("Supervisor");
    promoteMeetingComposerConfig("draft:sample", "thread:env-1:new");
    expect(useMeetingComposerStore.getState().configsByFolder["thread:env-1:new"]).toBe(promoted);
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
    expect(config.enabled).toBe(false);
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
