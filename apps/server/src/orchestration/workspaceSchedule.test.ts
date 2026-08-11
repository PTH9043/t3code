import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceScheduleNextTrigger } from "./workspaceSchedule.ts";

describe("Workspace schedule timing", () => {
  it("runs an overdue one-time schedule once", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "once", runAt: "2026-08-08T00:00:00.000Z" },
        now: "2026-08-08T01:00:00.000Z",
        lastTriggeredAt: null,
      }),
    ).toEqual({ nextTriggerAt: "2026-08-08T00:00:00.000Z", error: null });
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "once", runAt: "2026-08-08T00:00:00.000Z" },
        now: "2026-08-08T01:00:00.000Z",
        lastTriggeredAt: "2026-08-08T00:00:00.000Z",
      }).nextTriggerAt,
    ).toBeNull();
  });

  it("skips missed interval fan-out and returns the next aligned occurrence", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: {
          kind: "interval",
          everyMinutes: 30,
          startAt: "2026-08-08T00:00:00.000Z",
        },
        now: "2026-08-08T01:17:00.000Z",
        lastTriggeredAt: null,
      }).nextTriggerAt,
    ).toBe("2026-08-08T01:30:00.000Z");
  });

  it("resolves daily local time in the selected IANA time zone", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "daily", localTime: "09:00", timeZone: "Asia/Seoul" },
        now: "2026-08-08T00:01:00.000Z",
        lastTriggeredAt: null,
      }).nextTriggerAt,
    ).toBe("2026-08-09T00:00:00.000Z");
  });

  it("reports an invalid time zone instead of silently using the host zone", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "daily", localTime: "09:00", timeZone: "Mars/Olympus" },
        now: "2026-08-08T00:00:00.000Z",
        lastTriggeredAt: null,
      }).error,
    ).toContain("Unknown IANA time zone");
  });
});
