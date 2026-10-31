import type { OrchestrationThreadShell, WorkspaceAgentControlRecord } from "@t3tools/contracts";

export const agentControlStatusLabels: Record<WorkspaceAgentControlRecord["status"], string> = {
  queued: "다음 입력 대기",
  dispatching: "전송 중",
  accepted: "제공자 입력 수락",
  read: "작업자 도구 확인",
  cancelled: "취소",
  unknown: "수락 여부 확인 필요",
  prepared: "입력 보존됨",
  recorded: "응답 기록됨",
};
export const attentionKindLabels = {
  approval: "권한 승인",
  question: "질문",
  plan: "계획 확인",
  error: "오류",
  verification: "완료 검증",
  "usage-wait": "제한 대기",
} as const;
export type AttentionKind = keyof typeof attentionKindLabels;

/** Shell booleans are authoritative. Opening an item loads the existing request form. */
export function threadAttentionItems<
  T extends OrchestrationThreadShell & { environmentId: string },
>(threads: ReadonlyArray<T>) {
  const items: { id: string; kind: AttentionKind; thread: T }[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt) continue;
    const kinds: AttentionKind[] = [];
    if (thread.hasPendingApprovals) kinds.push("approval");
    if (thread.hasPendingUserInput) kinds.push("question");
    if (thread.hasActionableProposedPlan) kinds.push("plan");
    if (
      !kinds.length &&
      (thread.session?.status === "error" || thread.latestTurn?.state === "error")
    )
      kinds.push("error");
    for (const kind of kinds) {
      const id = thread.environmentId + ":" + thread.id + ":" + kind;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, kind, thread });
    }
  }
  return items.sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
}
