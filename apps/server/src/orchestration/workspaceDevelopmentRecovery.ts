import type {
  DevelopmentFailureRecovery,
  DevelopmentRecoveryStrategy,
  DevelopmentTask,
  DevelopmentWorkspace,
  WorkspaceDevelopmentState,
} from "@t3tools/contracts";

export function classifyDevelopmentFailure(
  detail: string,
  delivery: DevelopmentTask["delivery"],
  cancelled = false,
): typeof DevelopmentFailureRecovery.Type {
  if (delivery === "submitting" || delivery === "delivery_unknown")
    return {
      kind: "delivery-unknown",
      strategy: "diagnose-environment",
      retryAllowed: false,
      instruction:
        "동일 native session의 입력 수락·진행·완료 기록을 확인하세요. 전달 여부를 확인하기 전 같은 입력을 재전송하지 마세요.",
    };
  if (cancelled)
    return {
      kind: "cancelled",
      strategy: "clarify-requirement",
      retryAllowed: false,
      instruction: "사용자가 중단한 실행입니다. 변경과 새 지시를 확인하고 제어권을 존중하세요.",
    };
  if (
    /401|403|unauthori[sz]ed|authentication|api.?key|ENOENT|not found|cannot find module|command.*recognized|permission denied|EACCES|인증|설치|경로.*없/i.test(
      detail,
    )
  )
    return {
      kind: "environment",
      strategy: "diagnose-environment",
      retryAllowed: false,
      instruction:
        "cwd·실행 파일·의존성·인증 상태를 읽기 전용으로 진단하세요. 원인을 해결한 뒤 같은 환경과 모델로 검증하세요. 승인 밖의 계정·모델 전환은 하지 마세요.",
    };
  if (
    /429|502|503|504|ECONNRESET|ETIMEDOUT|rate.?limit|temporar|network|timed? ?out|timeout|통신|연결.*실패/i.test(
      detail,
    )
  )
    return {
      kind: "transient",
      strategy: "retry-after-check",
      retryAllowed: delivery === "pending",
      instruction:
        delivery === "pending"
          ? "서비스 상태와 미수락 입력을 확인한 뒤 한 번만 재시도하세요. 두 번째 실패부터 환경 진단으로 전환하세요."
          : "이미 수락된 실행입니다. native session의 진행과 완료를 확인한 뒤 새 복구 작업을 배정하세요. 동일 입력을 자동 재전송하지 마세요.",
    };
  if (/test|assert|typecheck|TS\d{4}|lint|compile|syntax|검증|테스트|타입|빌드/i.test(detail))
    return {
      kind: "verification",
      strategy: "repair-and-verify",
      retryAllowed: false,
      instruction:
        "실패한 검증 로그와 실제 코드를 읽고 원인을 수정하세요. 변경한 후보에서 같은 집중 검증을 실행하고 결과·후보 SHA를 기록하세요.",
    };
  if (
    /requirement|acceptance|ambiguous|conflict.*instruction|요구|완료조건|지시.*충돌/i.test(detail)
  )
    return {
      kind: "requirement",
      strategy: "clarify-requirement",
      retryAllowed: false,
      instruction:
        "현재 사용자 원문과 요구 개정, 완료조건을 비교하세요. 해결되지 않은 충돌은 구체적으로 보고하고 독단적으로 범위를 바꾸지 마세요.",
    };
  return {
    kind: "unknown",
    strategy: "diagnose-environment",
    retryAllowed: false,
    instruction:
      "원문 오류와 실행 단계, cwd·코드 변경·native session 상태를 확인한 뒤 복구 방법을 선택하세요. 근거 없이 같은 작업을 반복하지 마세요.",
  };
}

export function developmentDeliveryUnresolved(
  task: Pick<DevelopmentTask, "status" | "delivery">,
): boolean {
  return (
    task.status === "delivery_unknown" ||
    (task.status === "failed" &&
      (task.delivery === "submitting" || task.delivery === "delivery_unknown"))
  );
}

/** Same evidence requires an explicit, bounded recovery strategy before Main can dispatch again. */
export function developmentRecoveryBarrier(
  state: WorkspaceDevelopmentState,
  workspace: DevelopmentWorkspace,
  objective: string,
  strategy?: typeof DevelopmentRecoveryStrategy.Type,
) {
  const matching = state.tasks.filter(
    (task) => task.workspaceId === workspace.id && task.objective === objective,
  );
  // A changed checkout or goal revision cannot establish whether an input was accepted.
  if (matching.some(developmentDeliveryUnresolved))
    return "이전 입력의 전달 여부가 불명확합니다. native session 기록을 확인하기 전 재배정할 수 없습니다.";
  const failures = matching.filter(
    (task) =>
      task.requirementRevision === workspace.requirementRevision &&
      task.requestedAt >= (state.goal?.lastResumedAt ?? state.goal?.startedAt ?? "") &&
      task.status === "failed" &&
      (!task.failureCodeFingerprint ||
        task.failureCodeFingerprint === workspace.observedFingerprint),
  );
  const last = failures.at(-1);
  if (!last) return null;
  if (!strategy) return "동일 작업이 실패했습니다. 원인을 확인하고 recoveryStrategy를 선택하세요.";
  if (strategy === "retry-after-check") {
    const recovery =
      last.failureRecovery ?? classifyDevelopmentFailure(last.error ?? "", last.delivery);
    if (
      last.delivery !== "pending" ||
      !recovery.retryAllowed ||
      failures.some((task) => task.recoveryStrategy === strategy)
    )
      return "동일 입력의 자동 재시도 조건 또는 1회 상한을 충족하지 않습니다. 환경 진단이나 코드 수정으로 전환하세요.";
  } else if (failures.some((task) => task.recoveryStrategy === strategy)) {
    return "같은 복구 방법이 같은 코드에서 실패했습니다. 새 근거·수정 또는 다른 복구 방법이 필요합니다.";
  }
  return null;
}
