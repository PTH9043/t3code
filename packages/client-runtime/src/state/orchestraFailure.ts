import type { WorkspaceTaskNode, WorkspaceTaskValidationReceipt } from "@t3tools/contracts";

export interface OrchestraFailureDiagnostic {
  readonly kind:
    | "provider-unavailable"
    | "data-access"
    | "request-format"
    | "safety-refusal"
    | "delivery-unconfirmed"
    | "validation-rejected"
    | "execution-error";
  readonly label: string;
  readonly phase: string;
  readonly recovery: string;
  readonly action: string;
  readonly evidence?: readonly string[];
}

/** Uses recorded facts only; it does not guess the cause of an opaque error. */
export function diagnoseOrchestraFailure(
  node: WorkspaceTaskNode | undefined,
  receipt: WorkspaceTaskValidationReceipt | undefined,
): OrchestraFailureDiagnostic | null {
  if (!node || !["failed", "awaiting-user", "cancelled"].includes(node.status)) return null;
  const latestAttempt = node.attempts.at(-1);
  if (
    receipt &&
    receipt.verdict !== "pass" &&
    (!latestAttempt || receipt.recordedAt >= latestAttempt.startedAt)
  ) {
    return {
      kind: "validation-rejected",
      label: "검증 반려",
      phase: "검증",
      recovery: "검증 근거를 확인하고 해당 항목을 정정한 뒤 다시 검증",
      action: receipt.nextAction,
      evidence: receipt.evidence,
    };
  }
  const error = node.error ?? node.attempts.at(-1)?.error;
  if (!error) return null;
  if (
    /(?:flagged by (?:claude(?:'s|’s) )?safeguards|safeguards?\s+(?:flagged|stopped|blocked)\s+this\s+(?:session|message)|model_refusal|content_filter|(?:blocked|refused|rejected) by (?:the )?safety (?:filter|system)|안전\s*필터(?:에|가|로).*?(?:차단|거부))/iu.test(
      error,
    )
  ) {
    return {
      kind: "safety-refusal",
      label: "제공자 안전 필터 거절",
      phase: "모델 요청",
      recovery: "다른 모델로 자동 우회하지 않음",
      action: "거절 내용을 확인하고 필요한 처리를 선택하세요.",
    };
  }
  if (
    error.startsWith("선택한 AI 연결을 사용할 수 없습니다.") ||
    /Provider instance .* assigned to role .+ is unavailable/iu.test(error)
  ) {
    return {
      kind: "provider-unavailable",
      label: "선택한 AI 연결 사용 불가",
      phase: "연결 확인 또는 호출",
      recovery: "연결 상태를 확인한 뒤 해당 단계 복구",
      action: "표시된 연결의 등록·활성 상태를 확인하세요. 원인이 표시되지 않았다면 미확인입니다.",
    };
  }
  if (error.includes("이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다.")) {
    return {
      kind: "delivery-unconfirmed",
      label: "이전 입력 전달·종료 미확인",
      phase: "입력 전달",
      recovery: "자동 재전송 보류",
      action: "기존 결과와 외부 작업 실행 여부를 확인하세요.",
    };
  }
  if (/Expected ['"]function\.name['"] to be a string\./u.test(error)) {
    return {
      kind: "request-format",
      label: "함수 이름 형식 오류",
      phase: "실행 중 확인",
      recovery: "함수 이름 전달 경로를 확인한 뒤 해당 단계 복구",
      action: "오류 원문과 실행 기록을 확인하세요. 발생 지점은 추가 확인이 필요합니다.",
    };
  }
  if (
    /(?:인계|첨부|입력 파일|handoff|input file)/iu.test(error) &&
    /(?:ENOENT|EACCES|EPERM|hash mismatch|sha-?256[^\n]*mismatch|해시 불일치|찾을 수 없|권한)/iu.test(
      error,
    )
  ) {
    const label = /(?:hash mismatch|sha-?256[^\n]*mismatch|해시 불일치)/iu.test(error)
      ? "입력 자료 해시 불일치"
      : /(?:ENOENT|찾을 수 없)/iu.test(error)
        ? "입력 파일 없음"
        : "입력 자료 접근 권한 오류";
    return {
      kind: "data-access",
      label,
      phase: "자료 확인",
      recovery: "지정된 자료를 확인한 뒤 해당 단계 복구",
      action: "지정한 파일의 경로, 접근 권한과 해시를 확인하세요.",
    };
  }
  return {
    kind: "execution-error",
    label: "실행 오류 · 상세 원인 미확인",
    phase: "실행",
    recovery: "시도 기록과 현재 상태 확인 필요",
    action: "아래 오류 원문과 도구 기록을 확인하세요.",
  };
}
