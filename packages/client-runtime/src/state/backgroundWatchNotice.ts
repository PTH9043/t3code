/** Only an explicit monitor task type identifies a watch in a recovery receipt. */
export function isConfirmedMonitor(taskType: unknown): boolean {
  return taskType === "monitor" || taskType === "monitor_mcp";
}

export function interruptedWork(payload: Record<string, unknown>) {
  const tasks = Array.isArray(payload.interruptedTasks) ? payload.interruptedTasks : [];
  const monitorCount = tasks.filter((task) => isConfirmedMonitor(task?.taskType)).length;
  return {
    taskCount: tasks.length,
    monitorCount,
    lostWakeup: typeof payload.wakeupScheduledFor === "string",
  };
}

export function interruptedWorkLabel(work: ReturnType<typeof interruptedWork>): string {
  const otherCount = work.taskCount - work.monitorCount;
  return [
    work.monitorCount > 0 && `백그라운드 감시 ${work.monitorCount}개`,
    otherCount > 0 && `백그라운드 작업 ${otherCount}개`,
    work.lostWakeup && "예약된 자동 확인",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Older persisted summaries called every interrupted background shell a watch. */
export function recoveryHistoryLabel(
  kind: string,
  summary: string,
  payload: Record<string, unknown> | null,
): string {
  if (
    kind !== "session.recovered" ||
    !payload ||
    !summary.startsWith("서버 재시작으로 백그라운드 감시 ")
  )
    return summary;
  const work = interruptedWork(payload);
  if (work.taskCount === 0 || work.taskCount === work.monitorCount) return summary;
  return `서버 재시작으로 중단된 항목 · ${interruptedWorkLabel(work)}`;
}
