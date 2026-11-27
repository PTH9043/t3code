import { describe, expect, it } from "vite-plus/test";
import {
  isUpgradeRoomWorkspaceRoot,
  latestUpgradeRoomOfflineWork,
  shouldShowUpgradeRoomOfflineWork,
  UPGRADE_ROOM_OFFLINE_WORK_KIND,
} from "./upgradeRoomOfflineWork";

const work = {
  from: "2026-11-19T01:00:00.000Z",
  to: "2026-11-19T02:00:00.000Z",
  items: [
    {
      jobId: "job-1",
      request: "빌드 고치기",
      status: "completed",
      startedAt: "2026-11-19T01:05:00.000Z",
      finishedAt: "2026-11-19T01:30:00.000Z",
      questions: [{ question: "계속할까요?", handledAs: "decided" }],
    },
    { jobId: "job-2", request: "테스트", status: "running", startedAt: "2026-11-19T01:40:00.000Z" },
  ],
};

const activity = (id: string, payload: unknown, kind = UPGRADE_ROOM_OFFLINE_WORK_KIND) => ({
  id,
  kind,
  payload,
});

describe("latestUpgradeRoomOfflineWork", () => {
  it("returns the newest well-formed summary and skips malformed or unrelated rows", () => {
    const result = latestUpgradeRoomOfflineWork([
      activity("a1", work),
      activity("a2", { ...work, items: [{ jobId: "x", status: "done" }] }),
      activity("a3", work, "tool.completed"),
      activity("a4", null),
    ]);
    expect(result?.activityId).toBe("a1");
    expect(result?.work.items.map((item) => item.status)).toEqual(["completed", "running"]);
    expect(latestUpgradeRoomOfflineWork([activity("a5", "nope")])).toBeNull();
  });
});

describe("shouldShowUpgradeRoomOfflineWork", () => {
  const base = {
    threadId: "autousage-upgrade-room",
    enabled: true,
    activityId: "a1",
    seenActivityId: null,
  };
  it("shows an unseen summary only in the upgrade room with the setting on", () => {
    expect(shouldShowUpgradeRoomOfflineWork(base)).toBe(true);
    expect(shouldShowUpgradeRoomOfflineWork({ ...base, seenActivityId: "a1" })).toBe(false);
    expect(shouldShowUpgradeRoomOfflineWork({ ...base, seenActivityId: "a0" })).toBe(true);
    expect(shouldShowUpgradeRoomOfflineWork({ ...base, enabled: false })).toBe(false);
    expect(shouldShowUpgradeRoomOfflineWork({ ...base, threadId: "other" })).toBe(false);
    expect(shouldShowUpgradeRoomOfflineWork({ ...base, activityId: null })).toBe(false);
  });
});

describe("isUpgradeRoomWorkspaceRoot", () => {
  it("compares case-insensitively across slash styles", () => {
    expect(isUpgradeRoomWorkspaceRoot("d:\\__newautousage\\")).toBe(true);
    expect(isUpgradeRoomWorkspaceRoot("D:/__NewAutoUsage")).toBe(true);
    expect(isUpgradeRoomWorkspaceRoot("D:/__NewAutoUsage/apps")).toBe(false);
    expect(isUpgradeRoomWorkspaceRoot(null)).toBe(false);
  });
});
