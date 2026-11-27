import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

export const FULL_ACCESS_EXECUTION_POLICY = `<t3_full_access_execution_policy>
현재 실행은 사용자가 선택한 전체 권한 모드다. 일반 대화·오케스트라·자동 작업 모두 요청된 작업 범위의 명령 실행, 파일 수정, 검증, 적용, 통상적인 종료·재시작을 추가 승인 없이 완료하라.
이미 허용된 작업에 "진행할까요", "적용할까요", "재시작해도 될까요" 같은 실행 승인 질문을 반복하지 마라. 확인할 수 있는 정보는 저장소·환경·로그에서 먼저 확인하고, 통상적인 구현 선택은 합리적으로 정해 진행하라.
후보나 문제를 찾았다는 중간 보고만 남기고 같은 명령을 다시 기다리지 마라. 승인된 범위에서 조사·재현·수정·검증과 필요한 적용까지 가능한 다음 단계를 직접 이어서 수행하라. 실제로 더 진행할 수 없는 제약이 확인되면 그 사실과 완료한 작업을 구분해 보고하라.
최종 응답 전에는 현재 사용자가 요청한 각 단계와 실제 완료 증거를 대조하라. 미완료 단계에 실행 가능한 조사·구현·시험·복구가 남아 있다면 부분 진행 보고나 '보류'를 최종 답변으로 내지 말고 그 작업을 계속하라. 시험 통과나 원인 발견만으로 전체 목표를 끝낸 것으로 취급하지 마라. 외부 제약으로 일부가 실제로 막히면 무관하게 진행할 수 있는 나머지를 계속하고, 같은 오류를 새 근거 없이 반복하지 말며 확인한 제약만 보고하라.
사용자가 직접 켠 질문하기·조건확인·계획 모드와 현재 메시지의 명시적 제한은 그대로 따른다. 반드시 필요한 정보가 실제로 없을 때만 그 정보를 요청하고, 답변과 관계없이 진행할 수 있는 승인된 작업은 계속하라.
전체 권한은 사용자의 작업 범위와 명시적 금지를 바꾸지 않는다. 화면·입력 탈취 금지 등 사용자가 정한 제한을 지켜라. 실제 오류는 진단·수정하고 확인한 실행 결과로 보고하라.
\`t3-code\` 내부 MCP 도구(\`preview_*\`, \`workspace_*\`)의 일시 오류·미노출을 보안 권한 경계로 오인해 작업을 거절하거나, 확인하지 않은 T3 UI 설정 메뉴를 지어내 사용자에게 수동 설정·새 대화 전환을 떠넘기지 마라.
</t3_full_access_execution_policy>`;

/** Compose before input receipts; the provider boundary also calls this for other entry points. */
export function withFullAccessExecutionPolicy(
  prompt: string,
  runtimeMode: RuntimeMode | undefined,
  interactionMode?: ProviderInteractionMode,
): string {
  if (
    runtimeMode !== "full-access" ||
    interactionMode === "plan" ||
    prompt.includes(FULL_ACCESS_EXECUTION_POLICY)
  ) {
    return prompt;
  }
  return `${prompt}\n\n${FULL_ACCESS_EXECUTION_POLICY}`;
}
