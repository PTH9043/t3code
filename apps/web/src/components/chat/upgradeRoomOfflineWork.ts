import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const UPGRADE_ROOM_THREAD_ID = "autousage-upgrade-room";
export const UPGRADE_ROOM_WORKSPACE_ROOT = "D:/__NewAutoUsage";
export const UPGRADE_ROOM_TITLE = "AutoUsage 업그레이드 방";
export const UPGRADE_ROOM_OFFLINE_WORK_KIND = "upgrade-room.offline-work";
export const UPGRADE_ROOM_OFFLINE_WORK_SEEN_KEY = "t3.upgradeRoom.offlineWorkSeen";

export function isUpgradeRoomWorkspaceRoot(root: string | null | undefined): boolean {
  const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return typeof root === "string" && normalize(root) === normalize(UPGRADE_ROOM_WORKSPACE_ROOT);
}

const OfflineWorkPayload = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      jobId: Schema.String,
      request: Schema.String,
      status: Schema.Literals(["completed", "failed", "cancelled", "running", "unknown"]),
      startedAt: Schema.String,
      finishedAt: Schema.optionalKey(Schema.String),
      questions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            question: Schema.String,
            handledAs: Schema.Literals(["decided", "waiting"]),
          }),
        ),
      ),
    }),
  ),
});
export type UpgradeRoomOfflineWork = typeof OfflineWorkPayload.Type;
export type UpgradeRoomOfflineWorkItem = UpgradeRoomOfflineWork["items"][number];

const decodePayload = Schema.decodeUnknownOption(OfflineWorkPayload);

export const OFFLINE_WORK_STATUS_LABELS: Record<UpgradeRoomOfflineWorkItem["status"], string> = {
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
  running: "진행 중",
  unknown: "알 수 없음",
};

/** Newest well-formed offline-work activity; malformed payloads are skipped. */
export function latestUpgradeRoomOfflineWork(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
  }>,
): { readonly activityId: string; readonly work: UpgradeRoomOfflineWork } | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== UPGRADE_ROOM_OFFLINE_WORK_KIND) continue;
    const work = decodePayload(activity.payload);
    if (Option.isSome(work)) return { activityId: activity.id, work: work.value };
  }
  return null;
}

export function shouldShowUpgradeRoomOfflineWork(input: {
  readonly threadId: string;
  readonly enabled: boolean;
  readonly activityId: string | null;
  readonly seenActivityId: string | null;
}): boolean {
  return (
    input.enabled &&
    input.threadId === UPGRADE_ROOM_THREAD_ID &&
    input.activityId !== null &&
    input.activityId !== input.seenActivityId
  );
}
