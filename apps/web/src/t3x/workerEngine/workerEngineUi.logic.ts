import {
  WORKER_HEARTBEAT_ABORT_MS,
  WORKER_HEARTBEAT_STALL_MS,
  type WorkerCallerKind,
  type WorkerDecisionGateRisk,
  type WorkerDecisionGateStatus,
  type WorkerDispatchRecord,
  type WorkerDispatchStatus,
  type WorkerMailboxMessageRecord,
  type WorkerMailboxMessageType,
  type WorkerStatusResult,
  type WorkerTaskRecord,
  type WorkerTaskStatus,
  type WorkerWorktreeState,
} from "@t3tools/contracts";

export type WorkerBadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "destructive";

export interface WorkerBadgeMeta {
  readonly label: string;
  readonly variant: WorkerBadgeVariant;
  readonly dotClass: string;
}

export const WORKER_TASK_STATUS_META: Record<WorkerTaskStatus, WorkerBadgeMeta> = {
  pending: { label: "대기", variant: "secondary", dotClass: "bg-muted-foreground/60" },
  ready: { label: "준비됨", variant: "info", dotClass: "bg-info" },
  dispatched: { label: "작업 중", variant: "info", dotClass: "bg-info" },
  blocked: { label: "승인 대기", variant: "warning", dotClass: "bg-warning" },
  completed: { label: "완료", variant: "success", dotClass: "bg-success" },
  failed: { label: "실패", variant: "error", dotClass: "bg-destructive" },
  cancelled: { label: "중지됨", variant: "outline", dotClass: "bg-muted-foreground/60" },
};

export const WORKER_DISPATCH_STATUS_META: Record<WorkerDispatchStatus, WorkerBadgeMeta> = {
  starting: { label: "시작 중", variant: "info", dotClass: "bg-info" },
  running: { label: "실행 중", variant: "info", dotClass: "bg-info" },
  stalled: { label: "멈춤 의심", variant: "warning", dotClass: "bg-warning" },
  completed: { label: "완료", variant: "success", dotClass: "bg-success" },
  failed: { label: "실패", variant: "error", dotClass: "bg-destructive" },
  cancelled: { label: "중지됨", variant: "outline", dotClass: "bg-muted-foreground/60" },
  interrupted_by_restart: {
    label: "재시작 중단",
    variant: "warning",
    dotClass: "bg-warning",
  },
  abandoned: { label: "폐기됨", variant: "outline", dotClass: "bg-muted-foreground/50" },
};

export const WORKER_WORKTREE_STATE_META: Record<WorkerWorktreeState, WorkerBadgeMeta> = {
  none: { label: "현재 폴더", variant: "outline", dotClass: "bg-muted-foreground/40" },
  active: { label: "격리 작업 중", variant: "info", dotClass: "bg-info" },
  review_ready: { label: "검토 대기", variant: "warning", dotClass: "bg-warning" },
  merged: { label: "병합됨", variant: "success", dotClass: "bg-success" },
  discarded: { label: "폐기됨", variant: "outline", dotClass: "bg-muted-foreground/50" },
};

export const WORKER_MAILBOX_TYPE_META: Record<WorkerMailboxMessageType, WorkerBadgeMeta> = {
  dispatch: { label: "배정", variant: "outline", dotClass: "bg-info" },
  worker_done: { label: "작업 완료", variant: "success", dotClass: "bg-success" },
  merge_ready: { label: "병합 검토", variant: "warning", dotClass: "bg-warning" },
  escalation: { label: "경고 · 에스컬레이션", variant: "error", dotClass: "bg-destructive" },
  decision_gate: { label: "승인 요청", variant: "warning", dotClass: "bg-warning" },
  question: { label: "질문", variant: "info", dotClass: "bg-info" },
  answer: { label: "응답", variant: "secondary", dotClass: "bg-success" },
  heartbeat: { label: "하트비트", variant: "outline", dotClass: "bg-muted-foreground/60" },
  status: { label: "상태", variant: "secondary", dotClass: "bg-muted-foreground/60" },
};

export const WORKER_GATE_RISK_META: Record<WorkerDecisionGateRisk, WorkerBadgeMeta> = {
  medium: { label: "주의", variant: "info", dotClass: "bg-info" },
  high: { label: "높음", variant: "warning", dotClass: "bg-warning" },
  critical: { label: "위험", variant: "error", dotClass: "bg-destructive" },
};

export const WORKER_GATE_STATUS_META: Record<WorkerDecisionGateStatus, WorkerBadgeMeta> = {
  open: { label: "승인 대기", variant: "warning", dotClass: "bg-warning" },
  approved: { label: "승인됨", variant: "success", dotClass: "bg-success" },
  denied: { label: "거절됨", variant: "error", dotClass: "bg-destructive" },
  expired: { label: "만료됨", variant: "outline", dotClass: "bg-muted-foreground/60" },
};

export const WORKER_CALLER_KIND_LABELS: Record<WorkerCallerKind, string> = {
  t3_supervisor: "하위 위임",
  council: "다자간 위원회",
  orchestra: "오케스트라",
  personal_ai: "나만의 AI",
  cli: "CLI · 수동 파견",
};

export interface WorkerEngineSummaryCounts {
  readonly totalTasks: number;
  readonly activeCount: number;
  readonly stalledCount: number;
  readonly blockedCount: number;
  readonly reviewReadyCount: number;
  readonly openGateCount: number;
  readonly unreadMailboxCount: number;
  /** Items needing immediate user attention (open gates + stalled + review_ready). */
  readonly attentionCount: number;
}

export function computeWorkerEngineCounts(
  status: WorkerStatusResult | null | undefined,
): WorkerEngineSummaryCounts {
  if (!status) {
    return {
      totalTasks: 0,
      activeCount: 0,
      stalledCount: 0,
      blockedCount: 0,
      reviewReadyCount: 0,
      openGateCount: 0,
      unreadMailboxCount: 0,
      attentionCount: 0,
    };
  }

  let stalledCount = 0;
  for (const dispatch of status.activeDispatches) {
    if (dispatch.status === "stalled") {
      stalledCount += 1;
    }
  }

  let blockedCount = 0;
  let reviewReadyCount = 0;
  for (const task of status.tasks) {
    if (task.status === "blocked") {
      blockedCount += 1;
    }
    if (task.worktreeState === "review_ready") {
      reviewReadyCount += 1;
    }
  }

  const openGateCount = status.openGates.length;
  const activeCount = status.activeDispatches.length;
  const unreadMailboxCount = status.unreadMailboxCount;

  return {
    totalTasks: status.tasks.length,
    activeCount,
    stalledCount,
    blockedCount,
    reviewReadyCount,
    openGateCount,
    unreadMailboxCount,
    attentionCount: openGateCount + stalledCount + reviewReadyCount,
  };
}

function taskSortRank(
  task: WorkerTaskRecord,
  activeByTaskId: ReadonlyMap<string, WorkerDispatchRecord>,
): number {
  const active = activeByTaskId.get(task.taskId);
  if (active?.status === "stalled") return 0;
  if (task.status === "blocked") return 1;
  if (active) return 2;
  if (task.worktreeState === "review_ready") return 3;
  if (task.status === "pending" || task.status === "ready") return 4;
  if (task.status === "failed") return 5;
  if (task.status === "completed") return 6;
  return 7;
}

export function sortWorkerTasksForBoard(
  tasks: ReadonlyArray<WorkerTaskRecord>,
  activeDispatches: ReadonlyArray<WorkerDispatchRecord>,
): WorkerTaskRecord[] {
  const activeByTaskId = new Map<string, WorkerDispatchRecord>();
  for (const dispatch of activeDispatches) {
    activeByTaskId.set(dispatch.taskId, dispatch);
  }
  return [...tasks].sort((a, b) => {
    const rankDiff = taskSortRank(a, activeByTaskId) - taskSortRank(b, activeByTaskId);
    if (rankDiff !== 0) return rankDiff;
    return b.updatedAtMs - a.updatedAtMs;
  });
}

export function formatWorkerDurationMs(durationMs: number): string {
  const totalSec = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSec < 60) {
    return `${totalSec}초`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    return `${mins}분 ${String(secs).padStart(2, "0")}초`;
  }
  const hours = Math.floor(mins / 60);
  return `${hours}시간 ${String(mins % 60).padStart(2, "0")}분`;
}

export interface HeartbeatAgeDescription {
  readonly label: string;
  readonly severity: "ok" | "warning" | "danger";
  readonly ageMs: number;
}

export function describeHeartbeatAge(
  lastHeartbeatAtMs: number,
  nowMs: number,
  stallThresholdMs = WORKER_HEARTBEAT_STALL_MS,
  abortThresholdMs = WORKER_HEARTBEAT_ABORT_MS,
): HeartbeatAgeDescription {
  const ageMs = Math.max(0, nowMs - lastHeartbeatAtMs);
  if (ageMs >= abortThresholdMs) {
    return {
      label: `무응답 ${formatWorkerDurationMs(ageMs)} (중단 임계 초과)`,
      severity: "danger",
      ageMs,
    };
  }
  if (ageMs >= stallThresholdMs) {
    return {
      label: `무응답 ${formatWorkerDurationMs(ageMs)} (멈춤 의심)`,
      severity: "warning",
      ageMs,
    };
  }
  if (ageMs < 5_000) {
    return { label: "방금 신호", severity: "ok", ageMs };
  }
  return { label: `${formatWorkerDurationMs(ageMs)} 전 신호`, severity: "ok", ageMs };
}

export type ClassifiedDiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";

export interface ClassifiedDiffLine {
  readonly lineNumber: number;
  readonly kind: ClassifiedDiffLineKind;
  readonly text: string;
}

export interface ClassifiedDiffPatch {
  readonly lines: ReadonlyArray<ClassifiedDiffLine>;
  readonly truncated: boolean;
  readonly totalLineCount: number;
}

export function classifyDiffPatch(diffPatch: string, maxLines = 600): ClassifiedDiffPatch {
  if (!diffPatch.trim()) {
    return { lines: [], truncated: false, totalLineCount: 0 };
  }
  const rawLines = diffPatch.replace(/\r\n/g, "\n").split("\n");
  const totalLineCount = rawLines.length;
  const sliced = rawLines.slice(0, maxLines);
  const lines: ClassifiedDiffLine[] = sliced.map((text, index) => {
    let kind: ClassifiedDiffLineKind = "context";
    if (
      text.startsWith("diff --git") ||
      text.startsWith("index ") ||
      text.startsWith("--- ") ||
      text.startsWith("+++ ")
    ) {
      kind = "meta";
    } else if (text.startsWith("@@")) {
      kind = "hunk";
    } else if (text.startsWith("+")) {
      kind = "added";
    } else if (text.startsWith("-")) {
      kind = "removed";
    }
    return { lineNumber: index + 1, kind, text };
  });
  return {
    lines,
    truncated: totalLineCount > maxLines,
    totalLineCount,
  };
}

export interface MailboxAckPlan {
  readonly existingDeliveryIds: ReadonlyArray<string>;
  readonly hasUnclaimedMessages: boolean;
}

/**
 * Derive which existing `outstanding` deliveries can be acknowledged directly
 * and whether unclaimed messages must first be claimed via `check(peek: false)`.
 */
export function buildMailboxAckPlan(
  messages: ReadonlyArray<WorkerMailboxMessageRecord>,
): MailboxAckPlan {
  const deliveryIds = new Set<string>();
  let hasUnclaimedMessages = false;
  for (const message of messages) {
    if (message.acknowledgedAtMs !== null) continue;
    if (message.deliveryId) {
      deliveryIds.add(message.deliveryId);
    } else {
      hasUnclaimedMessages = true;
    }
  }
  return {
    existingDeliveryIds: [...deliveryIds],
    hasUnclaimedMessages,
  };
}

export function isWorktreeReviewable(task: WorkerTaskRecord): boolean {
  return (
    task.worktreeMode === "isolated" &&
    task.worktreePath !== null &&
    (task.worktreeState === "review_ready" || task.worktreeState === "active")
  );
}
