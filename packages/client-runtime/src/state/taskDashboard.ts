import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { hasQueuedTurnStart } from "./threadSettled.ts";

export const TASK_GROUPS = [
  "needs-input",
  "working",
  "completed",
  "failed",
  "monitoring",
  "idle",
] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];
export const taskGroupLabels: Record<TaskGroup, string> = {
  "needs-input": "답변·승인 대기",
  working: "작업 중",
  completed: "완료",
  failed: "실패",
  monitoring: "모니터링",
  idle: "대기·중단",
};
export function classifyDashboardTask(shell: OrchestrationThreadShell, now: string): TaskGroup {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.hasActionableProposedPlan)
    return "needs-input";
  if (
    shell.session?.status === "running" ||
    shell.session?.status === "starting" ||
    shell.latestTurn?.state === "running" ||
    shell.backgroundLiveness === "working" ||
    hasQueuedTurnStart(shell, { now })
  )
    return "working";
  if (shell.session?.status === "error" || shell.latestTurn?.state === "error") return "failed";
  if (shell.backgroundLiveness === "monitoring") return "monitoring";
  if (shell.latestTurn?.state === "completed") return "completed";
  return "idle";
}
