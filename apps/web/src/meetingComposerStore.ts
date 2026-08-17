import type { ProviderInstanceId, ScopedThreadRef, WorkspaceMeetingMode } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { DraftId } from "./composerDraftStore";

/**
 * The composer surface a meeting draft belongs to — the same identity the
 * composer draft store uses, so a meeting armed on a draft follows that draft
 * and a meeting armed on a thread stays with the thread.
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

export function meetingComposerKey(target: MeetingComposerTarget): string {
  return typeof target === "string" ? `draft:${target}` : scopedThreadKey(target);
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

interface MeetingComposerState {
  readonly configs: Readonly<Record<string, MeetingComposerConfig>>;
  readonly updateConfig: (
    target: MeetingComposerTarget,
    update: (config: MeetingComposerConfig) => MeetingComposerConfig,
  ) => void;
}

export const useMeetingComposerStore = create<MeetingComposerState>((set) => ({
  configs: {},
  updateConfig: (target, update) =>
    set((state) => {
      const key = meetingComposerKey(target);
      const current = state.configs[key] ?? DEFAULT_MEETING_COMPOSER_CONFIG;
      const next = update(current);
      if (next === current) return state;
      return { configs: { ...state.configs, [key]: next } };
    }),
}));

export function readMeetingComposerConfig(target: MeetingComposerTarget): MeetingComposerConfig {
  return (
    useMeetingComposerStore.getState().configs[meetingComposerKey(target)] ??
    DEFAULT_MEETING_COMPOSER_CONFIG
  );
}

export function useMeetingComposerConfig(target: MeetingComposerTarget): MeetingComposerConfig {
  const key = meetingComposerKey(target);
  return useMeetingComposerStore(
    useShallow((state) => state.configs[key] ?? DEFAULT_MEETING_COMPOSER_CONFIG),
  );
}

/** Same as `useMeetingComposerConfig`, for surfaces where meeting mode may be absent. */
export function useOptionalMeetingComposerConfig(
  target: MeetingComposerTarget | null,
): MeetingComposerConfig | null {
  const key = target === null ? null : meetingComposerKey(target);
  return useMeetingComposerStore(
    useShallow((state) =>
      key === null ? null : (state.configs[key] ?? DEFAULT_MEETING_COMPOSER_CONFIG),
    ),
  );
}

export function updateMeetingComposerConfig(
  target: MeetingComposerTarget,
  update: (config: MeetingComposerConfig) => MeetingComposerConfig,
): void {
  useMeetingComposerStore.getState().updateConfig(target, update);
}

/** The server's roster cap; a ninth checkbox is refused here rather than at send. */
export const MAX_MEETING_SEATS = 8;

/**
 * Check or uncheck one account's seat. The chair follows the roster: a chair
 * whose seat is removed falls back to automatic election rather than pointing
 * at an account that is no longer at the table.
 */
export function toggleMeetingComposerSeat(
  target: MeetingComposerTarget,
  seat: MeetingComposerSeat,
): void {
  updateMeetingComposerConfig(target, (config) => {
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

export function setMeetingComposerSeatModel(
  target: MeetingComposerTarget,
  seatId: string,
  model: string,
): void {
  updateMeetingComposerConfig(target, (config) => ({
    ...config,
    seats: config.seats.map((seat) => (seat.id === seatId ? { ...seat, model } : seat)),
  }));
}
