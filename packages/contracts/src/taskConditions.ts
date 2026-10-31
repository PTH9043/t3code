import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const ConditionText = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));

/** The editable conditions are approved together, for this request only. */
export const ApprovedTaskConditions = Schema.Struct({
  version: Schema.Literal(1),
  approvedByUser: Schema.Literal(true),
  sourceText: Schema.String.check(Schema.isMaxLength(100_000)),
  goal: ConditionText,
  scope: ConditionText,
  criteria: ConditionText,
  approach: ConditionText,
  restrictions: ConditionText,
  completion: ConditionText,
  output: ConditionText,
  mode: Schema.Literals(["inspect", "work"]),
  additionalActions: Schema.Array(Schema.Literals(["install", "delete", "external-write"])).check(
    Schema.isMaxLength(3),
  ),
});
export type ApprovedTaskConditions = typeof ApprovedTaskConditions.Type;

export const TASK_CONDITION_FIELDS = [
  ["goal", "이해한 목표"],
  ["scope", "대상과 범위"],
  ["criteria", "판단 기준"],
  ["approach", "수행 방법과 순서"],
  ["restrictions", "제외 대상과 금지 사항"],
  ["completion", "완료와 검증 기준"],
  ["output", "결과 형식"],
] as const;

export const ADDITIONAL_TASK_ACTIONS = [
  ["install", "패키지·프로그램 설치"],
  ["delete", "파일·데이터 삭제"],
  ["external-write", "외부 서비스에 게시·전송"],
] as const;

export function renderApprovedTaskConditions(conditions: ApprovedTaskConditions, request: string) {
  const extras = ADDITIONAL_TASK_ACTIONS.filter(([action]) =>
    conditions.additionalActions.includes(action),
  ).map(([, label]) => label);
  const excluded = ADDITIONAL_TASK_ACTIONS.filter(
    ([action]) => !conditions.additionalActions.includes(action),
  ).map(([, label]) => label);
  return [
    "# 사용자가 확정한 작업 조건",
    "아래 조건은 사용자가 양식에서 수정·검토한 뒤 이번 요청에 한해 승인했습니다.",
    ...TASK_CONDITION_FIELDS.map(([field, label]) => `## ${label}\n${conditions[field]}`),
    "## 허용 행동",
    conditions.mode === "inspect"
      ? "조회·분석·답변만 허용합니다. 파일 수정, 프로그램 시작·종료, 설치, 삭제, 외부 서비스 쓰기는 허용하지 않습니다."
      : "확정된 범위에서 파일 수정과 명령·프로그램 실행을 허용합니다.",
    ...(extras.length > 0 ? [`추가로 허용한 행동: ${extras.join(", ")}`] : []),
    ...(excluded.length > 0 ? [`허용하지 않은 행동: ${excluded.join(", ")}`] : []),
    "## 조건 적용",
    "요청에 없는 조건을 사용자 결정으로 바꾸지 마세요. 근거가 없거나 조건이 충돌하면 미확인으로 표시하고, 필요한 판단만 다시 물어보세요. 범위나 허용 행동을 바꿔야 하면 먼저 사용자 확인을 받으세요. 이미 확정한 항목을 반복해서 묻지 마세요.",
    "## 원래 요청과 첨부 맥락",
    request,
  ].join("\n\n");
}
