import type { ApprovedTaskConditions } from "@t3tools/contracts";

export function taskConditionsError(input: {
  readonly requireTaskConditions?: boolean | undefined;
  readonly taskConditions?: ApprovedTaskConditions | undefined;
  readonly message: { readonly text: string };
}): string | null {
  const conditions = input.taskConditions;
  if (input.requireTaskConditions && conditions === undefined)
    return "작업 조건을 작성하고 ‘이 조건으로 실행’을 눌러 주세요. 승인 전에는 작업을 시작할 수 없습니다.";
  if (conditions === undefined) return null;
  if (conditions.sourceText.trim() && !input.message.text.includes(conditions.sourceText))
    return "승인한 요청과 전송할 내용이 달라졌습니다. 변경된 요청의 조건을 다시 확인해 주세요.";
  if (conditions.mode === "inspect" && conditions.additionalActions.length > 0)
    return "조회 전용 조건에서는 설치·삭제·외부 쓰기를 허용할 수 없습니다.";
  return null;
}
