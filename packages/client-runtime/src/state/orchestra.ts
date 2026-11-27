import { WorkspaceOrchestraBlock, type MessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);

export function isLegacyUpgradeRoomExecutionId(value: unknown): value is string {
  return typeof value === "string" && /^upgrade-room-turn-[a-f0-9]{32}$/.test(value);
}

/** Block bodies remain ordinary messages so every client receives the same durable timeline. */
export function orchestraBlocksByMessage(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyMap<MessageId, WorkspaceOrchestraBlock> {
  const blocks = new Map<MessageId, WorkspaceOrchestraBlock>();
  for (const activity of activities) {
    if (activity.kind === "orchestra.block" && isOrchestraBlock(activity.payload)) {
      if (
        activity.payload.ownerThreadId === "autousage-upgrade-room" &&
        activity.payload.runId === "upgrade-room" &&
        isLegacyUpgradeRoomExecutionId(activity.payload.executionId)
      )
        continue;
      blocks.set(activity.payload.messageId, activity.payload);
    }
  }
  return blocks;
}

export const orchestraStatusLabels: Record<WorkspaceOrchestraBlock["status"], string> = {
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "중단",
  "awaiting-user": "답변 대기",
};

export const orchestraKindLabels: Record<WorkspaceOrchestraBlock["kind"], string> = {
  orchestration: "지휘",
  research: "조사",
  implementation: "구현",
  debug: "오류 수정",
  validation: "검증",
  synthesis: "최종 정리",
};
