import type {
  WorkspaceAgentRoleBinding,
  WorkspaceCollaborationRun,
  WorkspaceProgram,
  WorkspaceTaskAttempt,
  WorkspaceTaskNode,
} from "@t3tools/contracts";

export const WORKSPACE_INTEGRITY_CONVERGED_MARKER = "[T3_INTEGRITY_CONVERGED]";
export const WORKSPACE_INTEGRITY_CONTINUE_MARKER = "[T3_INTEGRITY_CONTINUE]";

const latestCompletedAttempt = (node: WorkspaceTaskNode): WorkspaceTaskAttempt | undefined =>
  [...node.attempts].reverse().find((attempt) => attempt.status === "completed");

export interface WorkspaceProgramIntegrityEvaluation {
  readonly converged: boolean;
  readonly summary: string;
  readonly reasons: ReadonlyArray<string>;
  readonly distinctInstanceIds: ReadonlyArray<string>;
  readonly validationCount: number;
}

export function evaluateWorkspaceProgramIntegrityRun(
  run: Pick<WorkspaceCollaborationRun, "graph" | "finalOutput" | "error" | "status">,
): WorkspaceProgramIntegrityEvaluation {
  const graph = run.graph;
  const reasons: string[] = [];
  if (run.status !== "completed") reasons.push(`협업 실행 상태가 ${run.status}입니다.`);
  if (graph === null) {
    reasons.push("구조화된 작업 그래프가 없습니다.");
    return {
      converged: false,
      summary: (run.finalOutput ?? run.error ?? reasons.join(" ")).slice(0, 65_536),
      reasons,
      distinctInstanceIds: [],
      validationCount: 0,
    };
  }

  if (graph.status !== "completed") reasons.push(`작업 그래프 상태가 ${graph.status}입니다.`);
  if (graph.overallConfidence === null || graph.overallConfidence === "low") {
    reasons.push("전체 신뢰도가 충분하지 않습니다.");
  }

  const nodes = new Map(graph.nodes.map((node) => [String(node.id), node]));
  const completedAttempts = graph.nodes.flatMap((node) =>
    node.attempts.filter((attempt) => attempt.status === "completed"),
  );
  const distinctInstanceIds = [
    ...new Set(completedAttempts.map((attempt) => String(attempt.modelSelection.instanceId))),
  ];
  if (distinctInstanceIds.length < 2) {
    reasons.push("서로 다른 등록 CLI 계정 2개 이상이 실제 작업에 참여하지 않았습니다.");
  }

  const activeValidations = graph.nodes.filter((node) => {
    if (node.kind !== "validation" || node.validation === null) return false;
    return nodes.get(String(node.validation.targetNodeId))?.status === "completed";
  });
  if (activeValidations.length === 0) reasons.push("완료된 작업을 검증한 영수증이 없습니다.");
  for (const validationNode of activeValidations) {
    const validation = validationNode.validation;
    if (validation === null) continue;
    if (validation.verdict !== "pass" || validation.confidence === "low") {
      reasons.push(`${validationNode.title} 검증이 통과하지 않았습니다.`);
    }
    const target = nodes.get(String(validation.targetNodeId));
    const targetAttempt = target === undefined ? undefined : latestCompletedAttempt(target);
    const verifierAttempt = latestCompletedAttempt(validationNode);
    if (
      targetAttempt === undefined ||
      verifierAttempt === undefined ||
      targetAttempt.modelSelection.instanceId === verifierAttempt.modelSelection.instanceId
    ) {
      reasons.push(`${validationNode.title} 검증자가 자신의 작업을 승인했습니다.`);
    }
  }

  if (!run.finalOutput?.trimEnd().endsWith(WORKSPACE_INTEGRITY_CONVERGED_MARKER)) {
    reasons.push("개선 사항이 없다는 명시적 수렴 판정이 없습니다.");
  }

  return {
    converged: reasons.length === 0,
    summary: (run.finalOutput ?? run.error ?? graph.nextAction).slice(0, 65_536),
    reasons,
    distinctInstanceIds,
    validationCount: activeValidations.length,
  };
}

export function buildWorkspaceProgramIntegrityTask(input: {
  readonly program: WorkspaceProgram;
  readonly cycle: number;
  readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
  readonly priorSummary: string | null;
}): string {
  const { program } = input;
  const participants = input.bindings
    .filter((binding) => binding.enabled)
    .map(
      (binding) =>
        `- ${binding.role}: ${binding.displayName} (${binding.modelSelection.instanceId})`,
    )
    .join("\n");
  const validationCommands =
    program.integrity.validationCommands.length > 0
      ? program.integrity.validationCommands.map((command) => `- ${command}`).join("\n")
      : "- 저장소에서 관련 focused test, lint, typecheck 명령을 찾아 실행";
  const healthCheck =
    program.healthCheck === null ? "등록된 상태검사 없음" : JSON.stringify(program.healthCheck);

  return [
    "# 프로그램 무결성 수렴 루프",
    `프로그램: ${program.name} (${program.id})`,
    `프로젝트 내 경로: ${program.relativeDirectory || "."}`,
    `실행 명령: ${program.command}`,
    `현재 수렴 주기: ${input.cycle}`,
    `상태검사: ${healthCheck}`,
    "## 실제 참여 가능한 등록 CLI",
    participants || "- 없음",
    "## 반드시 지킬 역할 분리",
    "1. 첫 CLI가 코드, 설정, 테스트, 실행 경로, 성능, 오류 가능성을 적대적으로 점검해 실행 가능한 개선 항목과 증거를 제시합니다.",
    "2. 다른 CLI 계정이 각 항목을 재현하고 실제 코드 수정과 최소 범위 검증을 수행합니다.",
    "3. 수정에 참여하지 않은 다른 CLI 계정이 변경분과 프로그램 동작을 다시 공격적으로 검증합니다. 자신의 작업을 스스로 승인하면 안 됩니다.",
    "4. 검증 실패, 불명확한 가정, 새 개선 항목이 있으면 그래프를 수정하고 다시 점검·수정·재검증합니다.",
    "5. 발견 사항, 수정 파일, 실행한 명령, 결과, 사용한 CLI instanceId를 노드별 증거에 남깁니다.",
    "## 필수 검증 명령",
    validationCommands,
    "## 종료 판정",
    `실행 가능한 개선 사항이 하나도 남지 않고, 모든 필수 검증과 상태검사가 통과하며, 수정하지 않은 별도 CLI 검증자가 동의할 때만 최종 출력 끝에 ${WORKSPACE_INTEGRITY_CONVERGED_MARKER}를 기록합니다.`,
    `그 외에는 남은 개선 사항과 다음 행동을 구체적으로 적고 최종 출력 끝에 ${WORKSPACE_INTEGRITY_CONTINUE_MARKER}를 기록합니다.`,
    "'완전 무결'을 근거 없이 주장하지 말고 이번 주기에서 확인한 운영상 수렴 증거만 보고합니다.",
    "## 이전 주기 요약",
    input.priorSummary ?? "첫 주기",
  ].join("\n\n");
}
