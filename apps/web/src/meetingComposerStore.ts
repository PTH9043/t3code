import type { ProviderInstanceId, ScopedThreadRef, WorkspaceMeetingMode } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { DraftId } from "./composerDraftStore";

/**
 * The composer surface a meeting send goes out from. The value no longer
 * scopes the settings — meeting mode is one app-wide switch — but pickers
 * still pass it so only the chat composer's picker (never a settings picker)
 * shows the meeting UI.
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

interface MeetingComposerState {
  readonly config: MeetingComposerConfig;
  readonly updateConfig: (update: (config: MeetingComposerConfig) => MeetingComposerConfig) => void;
}

/**
 * ONE config for the whole app, persisted: meeting mode is a switch the
 * person turns off, not per-conversation state. Armed once, it stays armed
 * across conversations, folders, tabs and app restarts until they turn it
 * off — the roster travels with them.
 */
export const useMeetingComposerStore = create<MeetingComposerState>()(
  persist(
    (set) => ({
      config: DEFAULT_MEETING_COMPOSER_CONFIG,
      updateConfig: (update) =>
        set((state) => {
          const next = update(state.config);
          return next === state.config ? state : { config: next };
        }),
    }),
    {
      name: "t3.meeting-composer.v1",
      partialize: (state) => ({ config: state.config }),
    },
  ),
);

export function readMeetingComposerConfig(): MeetingComposerConfig {
  return useMeetingComposerStore.getState().config;
}

export function useMeetingComposerConfig(): MeetingComposerConfig {
  return useMeetingComposerStore(useShallow((state) => state.config));
}

export function updateMeetingComposerConfig(
  update: (config: MeetingComposerConfig) => MeetingComposerConfig,
): void {
  useMeetingComposerStore.getState().updateConfig(update);
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
