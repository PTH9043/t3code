import type {
  DevelopmentTask,
  DevelopmentVerification,
  DevelopmentWorkspace,
  ModelSelection,
  WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import { developmentDeliveryUnresolved } from "./workspaceDevelopmentRecovery.ts";

export function sameDevelopmentModel(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? []) === JSON.stringify(right.options ?? [])
  );
}

export function developmentDispatchBarrier(
  state: WorkspaceDevelopmentState,
  workspace: DevelopmentWorkspace,
): string | null {
  if (!state.enabled) return "지속 작업실 운영이 꺼져 있습니다.";
  if (workspace.status !== "ready") return "작업실 구성과 실제 세션 연결을 먼저 완료해야 합니다.";
  if (workspace.control !== "managed" || workspace.summaryPending || workspace.externalUnmanaged)
    return "사용자 개입 또는 외부 변경을 먼저 확인하고 재조정해야 합니다.";
  if (state.mainObservedRevision < workspace.stateRevision)
    return "Main이 최신 작업실 상태를 조회해야 합니다.";
  return null;
}

export function developmentVerificationBarrier(
  workspace: DevelopmentWorkspace,
  verification: DevelopmentVerification,
  headSha: string,
): string | null {
  if (workspace.control !== "managed" || workspace.summaryPending || workspace.externalUnmanaged)
    return "사용자 개입 또는 외부 변경이 아직 재조정되지 않았습니다.";
  if (verification.status !== "passed") return "통과한 검증 결과가 필요합니다.";
  if (verification.candidateSha !== headSha) return "검증한 커밋 이후 Owner 커밋이 바뀌었습니다.";
  if (
    verification.requirementRevision !== workspace.requirementRevision ||
    verification.generation !== workspace.generation
  )
    return "요구사항 또는 작업실 세대가 검증 이후 변경되었습니다.";
  return null;
}

export function developmentTaskMayRun(
  workspace: DevelopmentWorkspace,
  task: DevelopmentTask,
): boolean {
  return (
    workspace.status === "ready" &&
    task.status === "queued" &&
    task.delivery === "pending" &&
    task.requirementRevision === workspace.requirementRevision &&
    (task.source === "user-direct" || workspace.control === "managed") &&
    !workspace.externalUnmanaged
  );
}

export function supersedeDevelopmentTasks(
  tasks: readonly DevelopmentTask[],
  workspaceId: string,
): DevelopmentTask[] {
  return tasks.map((task) =>
    task.workspaceId === workspaceId &&
    task.source === "main-dispatch" &&
    (task.status === "queued" || task.status === "running" || developmentDeliveryUnresolved(task))
      ? { ...task, status: "superseded" as const }
      : task,
  );
}
