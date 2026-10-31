import type {
  DevelopmentGoal,
  OrchestrationThread,
  WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

// State revisions include acknowledgements. Only work evidence counts as progress.
export const developmentGoalFingerprint = (state: WorkspaceDevelopmentState) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        workspaces: state.workspaces.map((w) => [
          w.id,
          w.requirementRevision,
          w.generation,
          w.status,
        ]),
        tasks: state.tasks.map((t) => [t.id, t.status, t.delivery, t.candidateSha]),
        verifications: state.verifications.map((v) => [v.id, v.status]),
        integrations: state.integrations.map((i) => [i.id, i.status, i.resultSha]),
      }),
    )
    .digest("hex");

export const developmentGoalElapsed = (goal: DevelopmentGoal, timestamp: string) =>
  goal.activeMilliseconds +
  (goal.activatedAt ? Math.max(0, Date.parse(timestamp) - Date.parse(goal.activatedAt)) : 0);

export function developmentGoalRepeatedFailure(state: WorkspaceDevelopmentState) {
  const goal = state.goal;
  if (!goal) return null;
  // An explicit resume permits another attempt without erasing failure history or usage.
  const since = goal.lastResumedAt ?? goal.startedAt;
  const goalTasks = state.tasks.filter(
    (task) => task.goalId === goal.id && task.status !== "superseded",
  );
  const tasks = goalTasks.filter((task) => task.requestedAt >= since);
  for (const group of Map.groupBy(tasks, (task) => task.workspaceId).values()) {
    const last = group.slice(-3);
    if (
      last.length === 3 &&
      last.every(
        (task) =>
          task.status === "failed" &&
          task.failureFingerprint &&
          task.failureFingerprint === last[0]!.failureFingerprint &&
          task.requirementRevision === last[0]!.requirementRevision,
      )
    )
      return "같은 코드 상태에서 동일한 실행 실패가 세 번 반복되었습니다. 원인과 보존된 결과를 확인한 뒤 재개하세요.";
  }
  const owners = new Set(goalTasks.map((task) => task.workspaceId));
  const verifications = state.verifications.filter(
    (verification) => owners.has(verification.workspaceId) && verification.verifiedAt >= since,
  );
  for (const group of Map.groupBy(
    verifications,
    (verification) => verification.workspaceId,
  ).values()) {
    const last = group.slice(-2);
    const evidence = (verification: (typeof last)[number]) =>
      JSON.stringify([
        verification.candidateSha,
        verification.requirementRevision,
        verification.generation,
        verification.commands.map((command) => [
          command.command,
          command.args,
          command.exitCode,
          command.timedOut,
        ]),
        verification.artifacts?.map((artifact) => [
          artifact.relativePath,
          artifact.sha256,
          artifact.error,
        ]),
      ]);
    if (
      last.length === 2 &&
      last.every((verification) => verification.status === "failed") &&
      evidence(last[0]!) === evidence(last[1]!)
    )
      return "수정되지 않은 동일 후보에서 같은 검증 실패가 반복되었습니다. 코드를 수정하거나 실패 원인을 해결한 뒤 재개하세요.";
  }
  return null;
}

export function developmentMainCompletionConfirmed(
  goal: DevelopmentGoal,
  thread: OrchestrationThread,
  nativeSessionId: string | null,
  expectedNativeSessionId: string | null,
) {
  const input = thread.messages.find(
    (message) => message.id === goal.pendingMessageId && message.role === "user",
  );
  return (
    !!nativeSessionId &&
    (!expectedNativeSessionId || nativeSessionId === expectedNativeSessionId) &&
    !!input?.turnId &&
    goal.progressReported &&
    thread.latestTurn?.turnId === input.turnId &&
    thread.latestTurn.state === "completed" &&
    thread.session?.activeTurnId === null &&
    ["idle", "ready"].includes(thread.session.status) &&
    thread.messages.some(
      (message) =>
        message.role === "assistant" && message.turnId === input.turnId && !message.streaming,
    )
  );
}

export const developmentGoalLimit = (
  goal: DevelopmentGoal,
  timestamp: string,
  state?: WorkspaceDevelopmentState,
) =>
  goal.steps >= goal.maxSteps
    ? "승인된 자동 진행 횟수에 도달했습니다."
    : developmentGoalElapsed(goal, timestamp) >= goal.maxMinutes * 60_000
      ? "승인된 자동 진행 시간에 도달했습니다."
      : goal.noProgressSteps >= 2
        ? "실행 증거가 늘지 않는 후속 작업이 반복되어 멈췄습니다."
        : state
          ? developmentGoalRepeatedFailure(state)
          : null;

export const developmentGoalInstructions = (goal: DevelopmentGoal) => `
사용자가 승인한 개발 목표: ${goal.objective}
완료조건: ${goal.acceptanceCriteria.join("; ")}
목표 ID ${goal.id}, 개정 ${goal.revision}, 상태 ${goal.status}, 단계 ${goal.steps}/${goal.maxSteps}.
목표의 보고된 토큰 예산: ${goal.maxTokens?.toLocaleString() ?? "미설정"}. status의 usage로 Main·Owner·재시도를 포함한 사용량과 미집계 범위를 확인하세요.
추가 지시를 기다리지 않고 이 목표에 필요한 다음 개발 작업을 진행하세요. 기존 Owner와 승인된 모델을 재사용하세요.
이번 응답을 끝내기 전에 workspace_manage action=goal-progress로 goalId, 최신 expectedGoalRevision,
objective(진행 요약), outcome을 기록하세요. status로 최신 개정을 읽으세요.
outcome=wait는 Owner 작업이 queued/running일 때만 사용하고, Owner 완료 후 관리 서비스가 이어갑니다.
outcome=continue는 다음 단계가 필요할 때, blocked는 사용자 결정이나 권한이 필요할 때 사용하세요.
완료조건을 충족하고 verify/integrate가 성공한 뒤에만 complete와 정확한 integrationId를 전달하세요.
중단·상한 상태에서는 자동 배정/신설/통합을 진행하지 마세요. 사용자 입력과 직접 제어권이 우선입니다.
목표를 달성했다고 말하는 것만으로 완료되지 않습니다. 목표 밖 개선, 공개·push·배포를 임의로 추가하지 마세요.
`;
