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

function seat(instanceId: string, displayName: string): MeetingComposerSeat {
  return {
    id: meetingSeatId(instanceId),
    instanceId: ProviderInstanceId.make(instanceId),
    model: "model-x",
    displayName,
  };
}

beforeEach(() => {
  useMeetingComposerStore.setState({ config: DEFAULT_MEETING_COMPOSER_CONFIG });
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

  it("keeps one app-wide config: arming once stays armed everywhere", () => {
    // Meeting mode is a switch the person turns off, not per-conversation
    // state — the same config answers no matter which surface asks.
    toggleMeetingComposerSeat(seat("claude-a", "Claude"));
    updateMeetingComposerConfig((config) => ({ ...config, enabled: true }));
    expect(readMeetingComposerConfig().enabled).toBe(true);
    expect(readMeetingComposerConfig().seats).toHaveLength(1);
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
