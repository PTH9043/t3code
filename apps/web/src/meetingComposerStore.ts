import {
  WorkspaceMeetingParticipantId,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type WorkspaceMeetingMode,
  type WorkspaceExecutionProfile,
  type WorkspaceMeetingSetup,
} from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { DraftId } from "./composerDraftStore";
import { useWorkspaceTabStore, workspaceTabViewKey } from "./workspaceTabStore";
import { randomUUID } from "./lib/utils";

/**
 * The composer surface a meeting send goes out from.
 */
export type MeetingComposerTarget = ScopedThreadRef | DraftId;

export interface MeetingComposerSeat {
  /** Stable participant id, independent of its account and selected model. */
  readonly id: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly displayName: string;
  readonly roleDescription?: string;
  /**
   * Provider option selections for this seat's turns — effort above all.
   * Same shape ModelSelection.options carries, so the server forwards them
   * to the seat's session untouched.
   */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

/** "토론 먼저" debates first; "바로 실행" skips discussion and plans straight away. */
export type MeetingComposerStyle = "meeting" | "collaboration";

export interface MeetingComposerConfig {
  readonly enabled: boolean;
  readonly executionMode?: "once" | "persistent";
  readonly style: MeetingComposerStyle;
  readonly mode: WorkspaceMeetingMode;
  readonly maxRounds: number;
  /** 실패 복구·재계획을 합친 그래프 수정 한도 (1–8). */
  readonly maxRevisions: number;
  readonly allowAdditionalWorkers: boolean;
  /**
   * 오케스트라는 이제 상시 모드다: armed면 실행 단계 노드들을 각자의 대화에서
   * 병렬로 돌린다. 이 플래그는 예전 설정 호환용으로만 남아 있고 send 경로는
   * 이를 보지 않는다 — 순차 실행은 병렬 폭 1로 표현한다.
   */
  readonly orchestraEnabled: boolean;
  /** 오케스트라 병렬 폭 (1–6, 1이면 순차). */
  readonly maxParallel: number;
  /**
   * 쓰기 연쇄(worktree) 격리: 수정 작업 묶음마다 전용 git worktree를 만들어
   * 병렬 수정을 허용한다. 꺼져 있으면 수정 작업은 한 번에 하나씩 실행된다.
   */
  readonly isolateWorktrees: boolean;
  readonly reviewPlan?: boolean;
  readonly resumeAfterLimit?: boolean;
  readonly verificationCommands?: ReadonlyArray<string>;
  readonly maxWorkerTurns?: number;
  readonly watchdogIntervalSeconds?: number | undefined;
  readonly userInLoop: boolean;
  /** Null means the user has not selected a supervisor. */
  readonly chairSeatId: string | null;
  readonly seats: ReadonlyArray<MeetingComposerSeat>;
  readonly executionProfile?: WorkspaceExecutionProfile;
}

const EMPTY_VERIFICATION_COMMANDS: ReadonlyArray<string> = [];

export const DEFAULT_MEETING_COMPOSER_CONFIG: MeetingComposerConfig = {
  enabled: false,
  executionMode: "once",
  style: "collaboration",
  mode: "fixed-rounds",
  maxRounds: 2,
  maxRevisions: 1,
  allowAdditionalWorkers: false,
  orchestraEnabled: true,
  maxParallel: 3,
  isolateWorktrees: false,
  reviewPlan: false,
  resumeAfterLimit: false,
  verificationCommands: EMPTY_VERIFICATION_COMMANDS,
  userInLoop: false,
  chairSeatId: null,
  seats: [],
};

/**
 * The style is its own field so "토론 먼저" and "바로 실행" never overwrite each
 * other's settings: switching styles must not touch the discussion round count.
 * The short-lived first cut encoded "바로 실행" as maxRounds 0 — fold those
 * entries forward and give the discussion side its rounds back.
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
    executionMode: config.executionMode === "persistent" ? "persistent" : "once",
    style,
    allowAdditionalWorkers: config.allowAdditionalWorkers ?? true,
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
    reviewPlan: config.reviewPlan === true,
    resumeAfterLimit: config.resumeAfterLimit === true,
    watchdogIntervalSeconds:
      typeof config.watchdogIntervalSeconds === "number" &&
      Number.isSafeInteger(config.watchdogIntervalSeconds) &&
      config.watchdogIntervalSeconds > 0
        ? config.watchdogIntervalSeconds
        : undefined,
    verificationCommands: config.verificationCommands ?? EMPTY_VERIFICATION_COMMANDS,
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

export function activeMeetingConversationKey(): string {
  const state = useWorkspaceTabStore.getState();
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return active && active.view.kind !== "control-center"
    ? workspaceTabViewKey(active.view)
    : activeFolderKey();
}

export function meetingConversationKeyForFolder(folderKey: string): string {
  const view = useWorkspaceTabStore.getState().lastChatViewByProjectKey[folderKey];
  return view ? workspaceTabViewKey(view) : folderKey;
}

function conversationConfig(
  configs: Readonly<Record<string, MeetingComposerConfig>>,
  conversationKey: string,
  folderKey: string,
): MeetingComposerConfig {
  const saved = configs[conversationKey];
  if (saved) return normalizeMeetingComposerConfig(saved);
  const legacy = configs[folderKey];
  return legacy && conversationKey !== folderKey
    ? normalizeMeetingComposerConfig({ ...legacy, enabled: false })
    : DEFAULT_MEETING_COMPOSER_CONFIG;
}

interface MeetingComposerState {
  readonly configsByFolder: Readonly<Record<string, MeetingComposerConfig>>;
  readonly updateConfig: (
    folderKey: string,
    update: (config: MeetingComposerConfig) => MeetingComposerConfig,
  ) => void;
}

/** Conversation settings are persisted under their stable view identity. */
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
  return conversationConfig(
    useMeetingComposerStore.getState().configsByFolder,
    activeMeetingConversationKey(),
    activeFolderKey(),
  );
}

export function useMeetingComposerConfig(): MeetingComposerConfig {
  const keys = useWorkspaceTabStore(
    useShallow((state) => {
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);
      const folderKey = active?.projectKey ?? NO_FOLDER_KEY;
      return {
        folderKey,
        conversationKey:
          active && active.view.kind !== "control-center"
            ? workspaceTabViewKey(active.view)
            : folderKey,
      };
    }),
  );
  return useMeetingComposerStore(
    useShallow((state) =>
      conversationConfig(state.configsByFolder, keys.conversationKey, keys.folderKey),
    ),
  );
}

export function useMeetingComposerConfigForFolder(folderKey: string): MeetingComposerConfig {
  const conversationKey = useWorkspaceTabStore((state) => {
    const view = state.lastChatViewByProjectKey[folderKey];
    return view ? workspaceTabViewKey(view) : folderKey;
  });
  return useMeetingComposerStore(
    useShallow((state) => conversationConfig(state.configsByFolder, conversationKey, folderKey)),
  );
}

export function meetingSetupFromConfig(config: MeetingComposerConfig): WorkspaceMeetingSetup {
  return {
    mode: config.mode,
    allowAdditionalWorkers: false,
    participants: config.seats.map((seat) => ({
      id: WorkspaceMeetingParticipantId.make(seat.id),
      displayName: seat.displayName,
      ...(seat.roleDescription ? { roleDescription: seat.roleDescription } : {}),
      modelSelection: {
        instanceId: seat.instanceId,
        model: seat.model,
        ...(seat.options ? { options: seat.options } : {}),
      },
    })),
    chairParticipantId: config.chairSeatId
      ? WorkspaceMeetingParticipantId.make(config.chairSeatId)
      : null,
    maxRounds: config.style === "collaboration" ? 0 : config.maxRounds,
    maxRevisions: config.maxRevisions,
    userInLoop: config.userInLoop,
  };
}

export function configFromExecutionProfile(
  config: MeetingComposerConfig,
  profile: WorkspaceExecutionProfile,
): MeetingComposerConfig {
  const { maxWorkerTurns: _previousWorkerLimit, ...previousConfig } = config;
  return {
    ...previousConfig,
    enabled: true,
    executionMode: profile.orchestra.executionMode ?? "once",
    style: profile.meeting.maxRounds === 0 ? "collaboration" : "meeting",
    mode: profile.meeting.mode,
    maxRounds: profile.meeting.maxRounds || DEFAULT_MEETING_COMPOSER_CONFIG.maxRounds,
    maxRevisions: profile.meeting.maxRevisions ?? 1,
    allowAdditionalWorkers: profile.meeting.allowAdditionalWorkers ?? false,
    userInLoop: profile.meeting.userInLoop,
    chairSeatId: profile.meeting.chairParticipantId,
    maxParallel: profile.orchestra.maxParallel,
    isolateWorktrees: profile.orchestra.isolateWorktrees,
    reviewPlan: profile.orchestra.reviewPlan === true,
    resumeAfterLimit: profile.orchestra.resumeAfterLimit === true,
    watchdogIntervalSeconds: profile.orchestra.watchdogIntervalSeconds,
    verificationCommands: profile.verificationCommands,
    ...(profile.orchestra.maxWorkerTurns === undefined
      ? {}
      : { maxWorkerTurns: profile.orchestra.maxWorkerTurns }),
    seats: profile.meeting.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      instanceId: participant.modelSelection.instanceId,
      model: participant.modelSelection.model,
      ...(participant.roleDescription ? { roleDescription: participant.roleDescription } : {}),
      ...(participant.modelSelection.options
        ? { options: participant.modelSelection.options }
        : {}),
    })),
    executionProfile: profile,
  };
}

export function updateMeetingComposerConfig(
  update: (config: MeetingComposerConfig) => MeetingComposerConfig,
): void {
  const store = useMeetingComposerStore.getState();
  const key = activeMeetingConversationKey();
  const current = conversationConfig(store.configsByFolder, key, activeFolderKey());
  store.updateConfig(key, () => update(current));
}

export function disarmMeetingComposer(key: string): void {
  useMeetingComposerStore.getState().updateConfig(key, (config) => ({ ...config, enabled: false }));
}

export function promoteMeetingComposerConfig(draftKey: string, threadKey: string): void {
  const store = useMeetingComposerStore.getState();
  const draft = store.configsByFolder[draftKey];
  if (!draft || store.configsByFolder[threadKey]) return;
  store.updateConfig(threadKey, () => ({ ...draft, enabled: false }));
}

/** Every added seat is independent, including seats using the same model. */
export function addMeetingComposerSeat(seat: Omit<MeetingComposerSeat, "id">): void {
  updateMeetingComposerConfig((config) => ({
    ...config,
    seats: [...config.seats, { ...seat, id: `seat-${randomUUID()}` }],
  }));
}

/**
 * Check or uncheck one account's seat. The chair follows the roster: a chair
 * whose seat is removed falls back to automatic election rather than pointing
 * at an account that is no longer at the table.
 */
export function toggleMeetingComposerSeat(seat: MeetingComposerSeat): void {
  updateMeetingComposerConfig((config) => {
    const existing = config.seats.find((candidate) => candidate.id === seat.id);
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

export function setMeetingComposerSeatModel(
  seatId: string,
  model: string,
  options: NonNullable<MeetingComposerSeat["options"]> = [],
): void {
  updateMeetingComposerConfig((config) => {
    const current = config.seats.find((seat) => seat.id === seatId);
    if (!current || current.model === model) return config;
    return {
      ...config,
      seats: config.seats.map((seat) => (seat.id === seatId ? { ...seat, model, options } : seat)),
    };
  });
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
