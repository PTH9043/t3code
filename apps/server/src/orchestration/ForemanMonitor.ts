import type { ForemanIndicatorReport, ForemanMonitorSnapshot } from "@t3tools/contracts";

export interface ForemanEvaluationInput {
  readonly nowMs: number;
  /** Most recent non-human event timestamp (ms), or null if unknown/empty. */
  readonly lastEventAtMs: number | null;
  readonly hasPendingUserQuestion: boolean;
  readonly hasPendingHostApproval: boolean;
  readonly hasIncompleteWork: boolean;
  /** Last assistant messages (chronological) for Loop cosine similarity check. */
  readonly recentAssistantMessages?: ReadonlyArray<string>;
  /** Pending handoff dispatches: `{ targetId, dispatchedAtMs, responded }`. */
  readonly handoffs?: ReadonlyArray<{
    readonly targetId: string;
    readonly dispatchedAtMs: number;
    readonly responded: boolean;
  }>;
  /** Active parallel workers and the file paths they touched/claimed. */
  readonly activeWorkerPaths?: ReadonlyArray<{
    readonly workerId: string;
    readonly paths: ReadonlyArray<string>;
  }>;
  /** Number of provider calls in the current shift window, or null if unavailable. */
  readonly shiftDispatchCount?: number | null;
  /** Expected scheduled routine trigger timestamps (ms) vs observed outputs. */
  readonly scheduledRoutines?: ReadonlyArray<{
    readonly routineId: string;
    readonly expectedRunAtMs: number;
    readonly observedOutputCount: number;
  }>;
  readonly unverifiedCompletionCount?: number;
  readonly thresholds?: {
    readonly stallMinutes?: number;
    readonly loopSimilarity?: number;
    readonly handoffWindowMs?: number;
    readonly agentBudget?: number;
  };
}

function trigramBag(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const bag = new Map<string, number>();
  if (normalized.length < 3) {
    if (normalized.length > 0) bag.set(normalized, 1);
    return bag;
  }
  for (let i = 0; i <= normalized.length - 3; i += 1) {
    const tri = normalized.slice(i, i + 3);
    bag.set(tri, (bag.get(tri) ?? 0) + 1);
  }
  return bag;
}

export function trigramCosineSimilarity(left: string, right: string): number {
  const a = trigramBag(left);
  const b = trigramBag(right);
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [k, v] of a) {
    normA += v * v;
    const bv = b.get(k);
    if (bv !== undefined) dot += v * bv;
  }
  for (const v of b.values()) normB += v * v;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Evaluates Foreman runtime telemetry indicators with explicit 3-state semantics
 * (`fired` | `clear` | `unavailable`) and non-guessing caveats, sorted by operator priority.
 */
export function evaluateForemanIndicators(input: ForemanEvaluationInput): ForemanMonitorSnapshot {
  const stallMs = (input.thresholds?.stallMinutes ?? 25) * 60_000;
  const loopThreshold = input.thresholds?.loopSimilarity ?? 0.9;
  const handoffWindowMs = input.thresholds?.handoffWindowMs ?? 10 * 60_000;
  const agentBudget = input.thresholds?.agentBudget ?? 128;

  const reports: ForemanIndicatorReport[] = [];

  // 1. Waiting on human question (Rank 1)
  reports.push({
    id: "waiting",
    label: "waiting on you",
    severityRank: 1,
    state: input.hasPendingUserQuestion ? "fired" : "clear",
    summary: input.hasPendingUserQuestion
      ? "사용자 결정·질문 답변을 대기 중입니다."
      : "대기 중인 사용자 질문이 없습니다.",
    caveat: "다른 채널에서 구두 해결되었을 수 있으나 최상단 확인 대상으로 배치됩니다.",
  });

  // 2. Host approval gate parked (Rank 2)
  reports.push({
    id: "approval_wait",
    label: "approval wait",
    severityRank: 2,
    state: input.hasPendingHostApproval ? "fired" : "clear",
    summary: input.hasPendingHostApproval
      ? "호스트 승인 게이트에 작업이 주차되어 있습니다."
      : "대기 중인 호스트 승인 요청이 없습니다.",
    caveat: "단순 채팅 답장이 아닌 네이티브 승인 카드 확인이 필요할 수 있습니다.",
  });

  // 3. Stall (Rank 3)
  if (input.lastEventAtMs === null) {
    reports.push({
      id: "stall",
      label: "age unknown",
      severityRank: 3,
      state: "unavailable",
      summary: "최근 이벤트 시각이 없어 정체 여부를 판정할 수 없습니다.",
      caveat: "관측 불가 상태를 정상(clear)으로 가정하지 않습니다.",
    });
  } else {
    const stalled =
      input.hasIncompleteWork &&
      !input.hasPendingUserQuestion &&
      !input.hasPendingHostApproval &&
      input.nowMs - input.lastEventAtMs >= stallMs;
    reports.push({
      id: "stall",
      label: "stopped mid-task",
      severityRank: 3,
      state: stalled ? "fired" : "clear",
      summary: stalled
        ? `미완료 작업의 최근 출력 이후 ${Math.floor((input.nowMs - input.lastEventAtMs) / 60_000)}분이 경과했습니다.`
        : "진행 중인 작업의 출력 정체가 감지되지 않았습니다.",
      caveat: "에이전트 프로세스 행(hang)을 단정할 수 없으며 외부 공급자 지연일 수 있습니다.",
    });
  }

  // 4. Loop detection on last 3 messages (Rank 4)
  const msgs = input.recentAssistantMessages;
  if (!msgs || msgs.length < 3) {
    reports.push({
      id: "loop",
      label: "repeating itself",
      severityRank: 4,
      state: "unavailable",
      summary: "최근 응답이 3건 미만이라 반복 루프를 판정할 수 없습니다.",
      caveat: "어휘 유사도가 곧 논리적 무한 루프를 의미하지는 않습니다.",
    });
  } else {
    const last3 = msgs.slice(-3);
    const s1 = trigramCosineSimilarity(last3[0]!, last3[1]!);
    const s2 = trigramCosineSimilarity(last3[1]!, last3[2]!);
    const looping = s1 >= loopThreshold && s2 >= loopThreshold;
    reports.push({
      id: "loop",
      label: "repeating itself",
      severityRank: 4,
      state: looping ? "fired" : "clear",
      summary: looping
        ? `인접 3개 응답 유사도가 ${Math.min(s1, s2).toFixed(2)}로 반복 루프 의심 구간입니다.`
        : `인접 응답 유사도 정상 (${Math.max(s1, s2).toFixed(2)}).`,
      caveat: "어휘 유사도가 곧 논리적 무한 루프를 의미하지는 않습니다.",
    });
  }

  // 5. Unverified completion claims (Rank 5)
  const unverifiedCount = input.unverifiedCompletionCount ?? 0;
  reports.push({
    id: "unverified",
    label: "unverified pass",
    severityRank: 5,
    state: unverifiedCount > 0 ? "fired" : "clear",
    summary:
      unverifiedCount > 0
        ? `독립 검증자 승인 없이 완료를 주장한 항목이 ${unverifiedCount}건 있습니다.`
        : "미검증 완료 주장이 없습니다.",
    caveat: "결과물이 틀렸다는 확정 증거는 아니나 완료 승인 처리는 보류됩니다.",
  });

  // 6. VM / File path collision across parallel workers (Rank 6)
  if (!input.activeWorkerPaths) {
    reports.push({
      id: "vm_collision",
      label: "file collision",
      severityRank: 6,
      state: "unavailable",
      summary: "병렬 워커 파일 경로 정보가 제공되지 않았습니다.",
      caveat: "동시 쓰기 경합이 아닌 공동 읽기일 수 있으므로 worktree 분리를 점검하세요.",
    });
  } else {
    const pathOwners = new Map<string, Set<string>>();
    for (const worker of input.activeWorkerPaths) {
      for (const rawPath of worker.paths) {
        const norm = rawPath.replaceAll("\\", "/").toLowerCase().trim();
        if (!norm) continue;
        const set = pathOwners.get(norm) ?? new Set<string>();
        set.add(worker.workerId);
        pathOwners.set(norm, set);
      }
    }
    const collided = [...pathOwners.entries()].filter(([, owners]) => owners.size >= 2);
    reports.push({
      id: "vm_collision",
      label: "file collision",
      severityRank: 6,
      state: collided.length > 0 ? "fired" : "clear",
      summary:
        collided.length > 0
          ? `병렬 워커가 동일 경로 ${collided.length}건(${collided[0]![0]})을 동시에 참조 중입니다.`
          : "병렬 워커 간 경로 충돌이 감지되지 않았습니다.",
      caveat: "동시 쓰기 경합이 아닌 단순 공동 읽기일 수 있으므로 git worktree 분리를 점검하세요.",
    });
  }

  // 7. Handoff drop (Rank 7)
  if (!input.handoffs) {
    reports.push({
      id: "handoff_drop",
      label: "handoff drop",
      severityRank: 7,
      state: "unavailable",
      summary: "위임 핸드오프 추적 데이터가 없습니다.",
      caveat: "관찰 창 바깥의 지연 응답 가능성이 존재합니다.",
    });
  } else {
    const dropped = input.handoffs.filter(
      (h) => !h.responded && input.nowMs - h.dispatchedAtMs >= handoffWindowMs,
    );
    reports.push({
      id: "handoff_drop",
      label: "handoff drop",
      severityRank: 7,
      state: dropped.length > 0 ? "fired" : "clear",
      summary:
        dropped.length > 0
          ? `응답 없는 핸드오프 ${dropped.length}건 (${dropped.map((d) => d.targetId).join(", ")}).`
          : "모든 핸드오프가 관찰 창 내에서 응답했습니다.",
      caveat: "관찰 창 바깥의 지연 응답 가능성이 존재합니다.",
    });
  }

  // 8. Quota burn (Rank 8)
  if (input.shiftDispatchCount === undefined || input.shiftDispatchCount === null) {
    reports.push({
      id: "quota_burn",
      label: "quota burn",
      severityRank: 8,
      state: "unavailable",
      summary: "교대조 내 호출 횟수 집계가 없습니다.",
      caveat: "전송 횟수는 달러 과금액이나 정확한 토큰 수치가 아닙니다.",
      usageIsIncomplete: true,
    });
  } else {
    const burning = input.shiftDispatchCount >= agentBudget;
    reports.push({
      id: "quota_burn",
      label: "quota burn",
      severityRank: 8,
      state: burning ? "fired" : "clear",
      summary: burning
        ? `교대조 호출 ${input.shiftDispatchCount}회로 예산 임계(${agentBudget}회)를 초과했습니다.`
        : `교대조 호출 ${input.shiftDispatchCount}/${agentBudget}회.`,
      caveat: "전송 횟수는 달러 과금액이나 정확한 토큰 수치가 아닙니다.",
      usageIsIncomplete: true,
    });
  }

  // 9. Silent routine (Rank 9)
  if (!input.scheduledRoutines) {
    reports.push({
      id: "silent_routine",
      label: "silent routine",
      severityRank: 9,
      state: "unavailable",
      summary: "스케줄 루틴 실행 이력이 제공되지 않았습니다.",
      caveat: "호스트에 루틴 타이머 자체가 미등록 상태일 수 있습니다.",
    });
  } else {
    const silent = input.scheduledRoutines.filter(
      (r) => input.nowMs >= r.expectedRunAtMs && r.observedOutputCount === 0,
    );
    reports.push({
      id: "silent_routine",
      label: "silent routine",
      severityRank: 9,
      state: silent.length > 0 ? "fired" : "clear",
      summary:
        silent.length > 0
          ? `예정 시각 경과 후 출력이 없는 루틴 ${silent.length}건 (${silent.map((r) => r.routineId).join(", ")}).`
          : "예정된 루틴이 정상 출력되었습니다.",
      caveat: "호스트에 루틴 타이머 자체가 미등록 상태일 수 있습니다.",
    });
  }

  const firedSorted = reports
    .filter((r) => r.state === "fired")
    .sort((a, b) => a.severityRank - b.severityRank);

  const highestSeverityLabel =
    firedSorted[0]?.label ??
    (reports.some((r) => r.id === "stall" && r.state === "unavailable")
      ? "age unknown"
      : "no indicator fired");

  return {
    evaluatedAtMs: input.nowMs,
    highestSeverityLabel,
    indicators: reports,
  };
}
