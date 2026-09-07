import type { ProviderInstanceId, ScopedThreadRef, WorkspaceMeetingMode } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { DraftId } from "./composerDraftStore";
import { useWorkspaceTabStore } from "./workspaceTabStore";

/**
 * The composer surface a meeting send goes out from. The value does not scope
 * the settings — those live per FOLDER — but pickers still pass it so only
 * the chat composer's picker (never a settings picker) shows the meeting UI.
 */
export type MeetingComposerTarget = ScopedThreadRef | DraftId;

export interface MeetingComposerSeat {
  /** Participant id sent to the server; derived from the instance id. */
  readonly id: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly displayName: string;
  /**
   * Provider option selections for this seat's turns — effort above all.
   * Same shape ModelSelection.options carries, so the server forwards them
   * to the seat's session untouched.
   */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

/** 회의 debates first; 협업 skips discussion and goes straight to the plan. */
export type MeetingComposerStyle = "meeting" | "collaboration";

export interface MeetingComposerConfig {
  readonly enabled: boolean;
  readonly style: MeetingComposerStyle;
  readonly mode: WorkspaceMeetingMode;
  readonly maxRounds: number;
  /** 협업의 횟수 제한: 실패 복구·재계획을 합친 그래프 수정 한도 (1–8). */
  readonly maxRevisions: number;
  /**
   * 오케스트라: 실행 단계의 노드들을 각자의 대화에서 병렬로 돌린다. 꺼져
   * 있으면 서버는 기존대로 회의 대화 하나에서 한 노드씩 실행한다.
   */
  readonly orchestraEnabled: boolean;
  /** 오케스트라 병렬 폭 (1–6). */
  readonly maxParallel: number;
  /**
   * 쓰기 연쇄(worktree) 격리: 수정 작업 묶음마다 전용 git worktree를 만들어
   * 병렬 수정을 허용한다. 꺼져 있으면 수정 작업은 한 번에 하나씩 실행된다.
   */
  readonly isolateWorktrees: boolean;
  readonly userInLoop: boolean;
  /** Null elects the first seat, mirroring the server's chair election. */
  readonly chairSeatId: string | null;
  readonly seats: ReadonlyArray<MeetingComposerSeat>;
}

export const DEFAULT_MEETING_COMPOSER_CONFIG: MeetingComposerConfig = {
  enabled: false,
  style: "meeting",
  mode: "fixed-rounds",
  maxRounds: 2,
  maxRevisions: 8,
  orchestraEnabled: false,
  maxParallel: 3,
  isolateWorktrees: false,
  userInLoop: false,
  chairSeatId: null,
  seats: [],
};

/**
 * The style is its own field so 회의 and 협업 never overwrite each other's
 * settings: switching styles must not touch the meeting's round count. The
 * short-lived first cut encoded 협업 as maxRounds 0 — fold those entries
 * forward and give the meeting side its rounds back.
 */
function normalizeMeetingComposerConfig(
  config:
    | MeetingComposerConfig
    | (Omit<
        MeetingComposerConfig,
        "style" | "maxRevisions" | "orchestraEnabled" | "maxParallel" | "isolateWorktrees"
      > & {
        style?: unknown;
        maxRevisions?: unknown;
        orchestraEnabled?: unknown;
        maxParallel?: unknown;
        isolateWorktrees?: unknown;
      }),
): MeetingComposerConfig {
  const style: MeetingComposerStyle =
    config.style === "collaboration" || config.style === "meeting"
      ? config.style
      : config.maxRounds === 0
        ? "collaboration"
        : "meeting";
  return {
    ...config,
    style,
    maxRounds:
      config.maxRounds === 0 ? DEFAULT_MEETING_COMPOSER_CONFIG.maxRounds : config.maxRounds,
    maxRevisions:
      typeof config.maxRevisions === "number" &&
      Number.isInteger(config.maxRevisions) &&
      config.maxRevisions >= 1 &&
      config.maxRevisions <= 8
        ? config.maxRevisions
        : DEFAULT_MEETING_COMPOSER_CONFIG.maxRevisions,
    // Persisted before the orchestra existed: off, at the default width.
    orchestraEnabled: config.orchestraEnabled === true,
    isolateWorktrees: config.isolateWorktrees === true,
    maxParallel:
      typeof config.maxParallel === "number" &&
      Number.isInteger(config.maxParallel) &&
      config.maxParallel >= 1 &&
      config.maxParallel <= 6
        ? config.maxParallel
        : DEFAULT_MEETING_COMPOSER_CONFIG.maxParallel,
  };
}

/**
 * A seat id doubles as the server-side participant id, which only accepts
 * `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Instance ids are slugs already; this
 * screens the exceptional one that is not instead of failing the send.
 */
export function meetingSeatId(instanceId: string): string {
  const cleaned = instanceId.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[._-]+/u, "");
  return (cleaned.length > 0 ? cleaned : "seat").slice(0, 64);
}

/** Settings written before the screen's folder is known land here. */
const NO_FOLDER_KEY = "__no-folder__";

/**
 * The folder the person is working in = the active tab's folder. Tab ids
 * come and go (tabs close, folder navigation recreates them) — the folder is
 * the identity that survives, which is why it scopes the meeting room.
 */
function activeFolderKey(): string {
  const state = useWorkspaceTabStore.getState();
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return active?.projectKey ?? NO_FOLDER_KEY;
}

interface MeetingComposerState {
  readonly configsByFolder: Readonly<Record<string, MeetingComposerConfig>>;
  readonly updateConfig: (
    folderKey: string,
    update: (config: MeetingComposerConfig) => MeetingComposerConfig,
  ) => void;
}

/**
 * One meeting setup PER FOLDER, persisted: each folder is its own meeting
 * room. Arming a roster in one folder never leaks into another, and within a
 * folder the switch stays on — across conversations, tabs, tab re-creations
 * and app restarts — until the person turns it off there.
 */
export const useMeetingComposerStore = create<MeetingComposerState>()(
  persist(
    (set) => ({
      configsByFolder: {},
      updateConfig: (folderKey, update) =>
        set((state) => {
          const current = normalizeMeetingComposerConfig(
            state.configsByFolder[folderKey] ?? DEFAULT_MEETING_COMPOSER_CONFIG,
          );
          const next = update(current);
          if (next === current) return state;
          return { configsByFolder: { ...state.configsByFolder, [folderKey]: next } };
        }),
    }),
    {
      name: "t3.meeting-composer.v3",
      partialize: (state) => ({ configsByFolder: state.configsByFolder }),
    },
  ),
);

// One-shot rescue of the short-lived per-tab store (v2): remap each tab's
// config onto the folder that tab was working in, so nobody re-arms a roster
// they already built.
try {
  const rawV2 = globalThis.localStorage?.getItem("t3.meeting-composer.v2");
  if (rawV2) {
    const configsByTabId = (
      JSON.parse(rawV2) as {
        state?: { configsByTabId?: Record<string, MeetingComposerConfig> };
      }
    ).state?.configsByTabId;
    if (configsByTabId) {
      const tabs = useWorkspaceTabStore.getState().tabs;
      const { configsByFolder, updateConfig } = useMeetingComposerStore.getState();
      for (const [tabId, config] of Object.entries(configsByTabId)) {
        const folderKey = tabs.find((tab) => tab.id === tabId)?.projectKey;
        if (folderKey && configsByFolder[folderKey] === undefined) {
          updateConfig(folderKey, () => config);
        }
      }
    }
    globalThis.localStorage?.removeItem("t3.meeting-composer.v2");
  }
} catch {
  // A malformed leftover must never break the composer.
}

export function readMeetingComposerConfig(): MeetingComposerConfig {
  return normalizeMeetingComposerConfig(
    useMeetingComposerStore.getState().configsByFolder[activeFolderKey()] ??
      DEFAULT_MEETING_COMPOSER_CONFIG,
  );
}

export function useMeetingComposerConfig(): MeetingComposerConfig {
  const folderKey = useWorkspaceTabStore((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return active?.projectKey ?? NO_FOLDER_KEY;
  });
  return useMeetingComposerStore(
    useShallow((state) =>
      normalizeMeetingComposerConfig(
        state.configsByFolder[folderKey] ?? DEFAULT_MEETING_COMPOSER_CONFIG,
      ),
    ),
  );
}

export function updateMeetingComposerConfig(
  update: (config: MeetingComposerConfig) => MeetingComposerConfig,
): void {
  useMeetingComposerStore.getState().updateConfig(activeFolderKey(), update);
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

/** Set one provider option (effort above all) on one seat's turns. */
export function setMeetingComposerSeatOption(
  seatId: string,
  optionId: string,
  value: string | boolean,
): void {
  updateMeetingComposerConfig((config) => ({
    ...config,
    seats: config.seats.map((seat) => {
      if (seat.id !== seatId) return seat;
      const options = [
        ...(seat.options ?? []).filter((option) => option.id !== optionId),
        { id: optionId, value },
      ];
      return { ...seat, options };
    }),
  }));
}
