import { ApprovedTaskConditions, TASK_CONDITION_FIELDS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isApprovedTaskConditions = Schema.is(ApprovedTaskConditions);

export interface TaskConditionsDraft {
  sourceText: string;
  goal: string;
  scope: string;
  criteria: string;
  approach: string;
  restrictions: string;
  completion: string;
  output: string;
  mode: "inspect" | "work" | null;
  additionalActions: ApprovedTaskConditions["additionalActions"];
}

export function createTaskConditionsDraft(
  sourceText: string,
  workspaceRoot: string,
): TaskConditionsDraft {
  return {
    sourceText,
    goal: sourceText.trim().slice(0, 8_000) || "첨부 자료를 확인하고 요청한 결과를 만듭니다.",
    scope: workspaceRoot
      ? `현재 프로젝트: ${workspaceRoot}\n추가 대상은 원래 요청에 명시된 범위로 한정합니다.`
      : "원래 요청에 명시한 대상만 다룹니다.",
    criteria:
      "원래 요청의 조건을 모두 적용합니다. 근거가 없는 내용은 미확인으로 표시하고 임의의 수치나 판단 기준을 추가하지 않습니다.",
    approach:
      "대상과 현재 상태를 먼저 확인하고, 아래에서 허용한 행동만 수행한 뒤 결과를 검증합니다.",
    restrictions:
      "요청과 관계없는 파일·프로세스·데이터는 변경하지 않습니다. 범위를 넓혀야 하면 먼저 확인합니다.",
    completion: "요청한 결과가 충족됐는지 확인하고, 검증 결과와 남은 제약을 함께 보고합니다.",
    output:
      "원래 요청에 지정된 형식을 따릅니다. 지정이 없으면 핵심 결과와 근거를 간결하게 정리합니다.",
    mode: null,
    additionalActions: [],
  };
}

export function approveTaskConditions(draft: TaskConditionsDraft, reviewed: boolean) {
  if (!reviewed || draft.mode === null) return null;
  if (TASK_CONDITION_FIELDS.some(([field]) => draft[field].trim().length === 0)) return null;
  if (draft.mode === "inspect" && draft.additionalActions.length > 0) return null;
  const approved = {
    ...draft,
    version: 1 as const,
    approvedByUser: true as const,
  };
  return isApprovedTaskConditions(approved) ? approved : null;
}
