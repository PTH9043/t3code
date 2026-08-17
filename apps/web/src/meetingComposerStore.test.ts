import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  DEFAULT_MEETING_COMPOSER_CONFIG,
  meetingSeatId,
  readMeetingComposerConfig,
  toggleMeetingComposerSeat,
  updateMeetingComposerConfig,
  useMeetingComposerStore,
  type MeetingComposerSeat,
} from "./meetingComposerStore";

const target = DraftId.make("draft-1");

function seat(instanceId: string, displayName: string): MeetingComposerSeat {
  return {
    id: meetingSeatId(instanceId),
    instanceId: ProviderInstanceId.make(instanceId),
    model: "model-x",
    displayName,
  };
}

beforeEach(() => {
  useMeetingComposerStore.setState({ configs: {} });
});

describe("meetingComposerStore", () => {
  it("starts from the disabled default", () => {
    expect(readMeetingComposerConfig(target)).toEqual(DEFAULT_MEETING_COMPOSER_CONFIG);
  });

  it("toggles seats on and off", () => {
    toggleMeetingComposerSeat(target, seat("claude-a", "Claude"));
    toggleMeetingComposerSeat(target, seat("codex-a", "Codex"));
    expect(readMeetingComposerConfig(target).seats.map((entry) => entry.id)).toEqual([
      "claude-a",
      "codex-a",
    ]);
    toggleMeetingComposerSeat(target, seat("claude-a", "Claude"));
    expect(readMeetingComposerConfig(target).seats.map((entry) => entry.id)).toEqual(["codex-a"]);
  });

  it("drops the chair back to automatic election when its seat leaves the table", () => {
    toggleMeetingComposerSeat(target, seat("claude-a", "Claude"));
    toggleMeetingComposerSeat(target, seat("codex-a", "Codex"));
    updateMeetingComposerConfig(target, (config) => ({ ...config, chairSeatId: "codex-a" }));
    toggleMeetingComposerSeat(target, seat("codex-a", "Codex"));
    expect(readMeetingComposerConfig(target).chairSeatId).toBeNull();
  });

  it("refuses a ninth seat instead of failing at send", () => {
    for (let index = 0; index < 9; index += 1) {
      toggleMeetingComposerSeat(target, seat(`seat-${index}`, `Seat ${index}`));
    }
    expect(readMeetingComposerConfig(target).seats).toHaveLength(8);
  });

  it("keeps configs isolated per composer target", () => {
    toggleMeetingComposerSeat(target, seat("claude-a", "Claude"));
    expect(readMeetingComposerConfig(DraftId.make("draft-2")).seats).toEqual([]);
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
