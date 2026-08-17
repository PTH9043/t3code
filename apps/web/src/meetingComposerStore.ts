import type { ProviderInstanceId, ScopedThreadRef, WorkspaceMeetingMode } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { DraftId } from "./composerDraftStore";
import { useWorkspaceTabStore } from "./workspaceTabStore";

/**
 * The composer surface a meeting send goes out from. The value does not scope
 * the settings — those live per workspace TAB — but pickers still pass it so
 * only the chat composer's picker (never a settings picker) shows the
 * meeting UI.
 */
export type MeetingComposerTarget = ScopedThreadRef | DraftId;

export interface MeetingComposerSeat {
  /** Participant id sent to the server; derived from the instance id. */
  readonly id: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly displayName: string;
}

export interface MeetingComposerConfig {
  readonly enabled: boolean;
  readonly mode: WorkspaceMeetingMode;
  readonly maxRounds: number;
  readonly userInLoop: boolean;
  /** Null elects the first seat, mirroring the server's chair election. */
  readonly chairSeatId: string | null;
  readonly seats: ReadonlyArray<MeetingComposerSeat>;
}

export const DEFAULT_MEETING_COMPOSER_CONFIG: MeetingComposerConfig = {
  enabled: false,
  mode: "fixed-rounds",
  maxRounds: 2,
  userInLoop: false,
  chairSeatId: null,
  seats: [],
};

/**
 * A seat id doubles as the server-side participant id, which only accepts
 * `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Instance ids are slugs already; this
 * screens the exceptional one that is not instead of failing the send.
 */
export function meetingSeatId(instanceId: string): string {
  const cleaned = instanceId.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[._-]+/u, "");
  return (cleaned.length > 0 ? cleaned : "seat").slice(0, 64);
}

/** Settings written before any tab exists land here and stay readable. */
const NO_TAB_KEY = "__no-tab__";

function activeMeetingScopeKey(): string {
  return useWorkspaceTabStore.getState().activeTabId ?? NO_TAB_KEY;
}

interface MeetingComposerState {
  readonly configsByTabId: Readonly<Record<string, MeetingComposerConfig>>;
  readonly updateConfig: (
    tabId: string,
    update: (config: MeetingComposerConfig) => MeetingComposerConfig,
  ) => void;
  readonly dropTabs: (keepTabIds: ReadonlySet<string>) => void;
}

/**
 * One meeting setup PER WORKSPACE TAB, persisted: each tab is its own meeting
 * room. Arming a roster in one tab never leaks into another, and within a tab
 * the switch stays on — across conversations and app restarts — until the
 * person turns it off there.
 */
export const useMeetingComposerStore = create<MeetingComposerState>()(
  persist(
    (set) => ({
      configsByTabId: {},
      updateConfig: (tabId, update) =>
        set((state) => {
          const current = state.configsByTabId[tabId] ?? DEFAULT_MEETING_COMPOSER_CONFIG;
          const next = update(current);
          if (next === current) return state;
          return { configsByTabId: { ...state.configsByTabId, [tabId]: next } };
        }),
      dropTabs: (keepTabIds) =>
        set((state) => {
          const entries = Object.entries(state.configsByTabId).filter(
            ([tabId]) => tabId === NO_TAB_KEY || keepTabIds.has(tabId),
          );
          if (entries.length === Object.keys(state.configsByTabId).length) return state;
          return { configsByTabId: Object.fromEntries(entries) };
        }),
    }),
    {
      name: "t3.meeting-composer.v2",
      partialize: (state) => ({ configsByTabId: state.configsByTabId }),
    },
  ),
);

// A closed tab takes its meeting room with it; without this the persisted map
// would keep growing with configs no tab can ever read again.
useWorkspaceTabStore.subscribe((state, previous) => {
  if (state.tabs === previous.tabs) return;
  useMeetingComposerStore.getState().dropTabs(new Set(state.tabs.map((tab) => tab.id)));
});

export function readMeetingComposerConfig(): MeetingComposerConfig {
  return (
    useMeetingComposerStore.getState().configsByTabId[activeMeetingScopeKey()] ??
    DEFAULT_MEETING_COMPOSER_CONFIG
  );
}

export function useMeetingComposerConfig(): MeetingComposerConfig {
  const activeTabId = useWorkspaceTabStore((state) => state.activeTabId) ?? NO_TAB_KEY;
  return useMeetingComposerStore(
    useShallow((state) => state.configsByTabId[activeTabId] ?? DEFAULT_MEETING_COMPOSER_CONFIG),
  );
}

export function updateMeetingComposerConfig(
  update: (config: MeetingComposerConfig) => MeetingComposerConfig,
): void {
  useMeetingComposerStore.getState().updateConfig(activeMeetingScopeKey(), update);
}

/** The server's roster cap; a ninth checkbox is refused here rather than at send. */
export const MAX_MEETING_SEATS = 8;

/**
 * Check or uncheck one account's seat. The chair follows the roster: a chair
 * whose seat is removed falls back to automatic election rather than pointing
 * at an account that is no longer at the table.
 */
export function toggleMeetingComposerSeat(seat: MeetingComposerSeat): void {
  updateMeetingComposerConfig((config) => {
    const existing = config.seats.find((candidate) => candidate.id === seat.id);
    if (existing === undefined && config.seats.length >= MAX_MEETING_SEATS) return config;
    const seats =
      existing === undefined
        ? [...config.seats, seat]
        : config.seats.filter((candidate) => candidate.id !== seat.id);
    const chairSeatId =
      config.chairSeatId !== null && seats.some((candidate) => candidate.id === config.chairSeatId)
        ? config.chairSeatId
        : null;
    return { ...config, seats, chairSeatId };
  });
}

export function setMeetingComposerSeatModel(seatId: string, model: string): void {
  updateMeetingComposerConfig((config) => ({
    ...config,
    seats: config.seats.map((seat) => (seat.id === seatId ? { ...seat, model } : seat)),
  }));
}
