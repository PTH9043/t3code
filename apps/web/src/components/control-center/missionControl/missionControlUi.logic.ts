import type {
  MissionCircuitBreakerState,
  MissionCrewRole,
  MissionCrewStatus,
  MissionDagStepStatus,
  MissionExecutionStyle,
  MissionMeetingStance,
  MissionMeetingStatus,
  MissionMeetingStyle,
  MissionModelTier,
  MissionOrgTier,
  MissionRun,
  MissionStatus,
  MissionTriggerReason,
  ServerProvider,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "~/providerInstances";

export interface MissionModelOption {
  readonly providerInstanceId: string;
  readonly providerDisplayName: string;
  readonly driverKind: string;
  readonly modelSlug: string;
  readonly modelName: string;
  readonly enabled: boolean;
  readonly status: string;
}

export interface MissionProviderGroupOption {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

const NON_CODING_MEDIA_MODEL_PATTERN =
  /(?:^|[/:_-])(?:wan[-_]?v?\d|seedance|seedream|hailuo|minimax[-_]?video|cogvideo|hunyuan[-_]?video|vidu|pixverse|recraft|ideogram|nano[-_]?banana|video|sora|kling|veo|runway|pika|luma|imagen|flux|dall-?e|midjourney|sdxl|stable-?diffusion|whisper|tts|audio|speech|transcribe|embed(?:ding)?|rerank(?:er)?|moderation|vision-only)(?:$|[/:_-])/i;

export function isMissionCodingCapableModel(slug: string, name?: string): boolean {
  return !NON_CODING_MEDIA_MODEL_PATTERN.test(`${slug} ${name ?? ""}`);
}

export function isMissionTerminable(status: MissionStatus): boolean {
  return (
    status === "CREATED" ||
    status === "PLANNING" ||
    status === "EXECUTING" ||
    status === "VERIFYING" ||
    status === "AWAITING_APPROVAL"
  );
}

export function buildMissionProviderOptions(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<MissionProviderGroupOption> {
  const entries = deriveProviderInstanceEntries(providers);
  return entries
    .filter((entry) => entry.enabled && entry.models.length > 0)
    .map((entry) => {
      const codingModels = entry.models.filter((m) => isMissionCodingCapableModel(m.slug, m.name));
      const effectiveModels = codingModels.length > 0 ? codingModels : entry.models;
      return {
        providerInstanceId: entry.instanceId,
        displayName: entry.displayName,
        driverKind: entry.driverKind,
        enabled: entry.enabled,
        status: entry.status,
        models: effectiveModels.map((m) => ({
          slug: m.slug,
          name: m.name || m.slug,
        })),
      };
    });
}

export const MISSION_STATUS_META: Record<
  MissionStatus,
  { readonly label: string; readonly variant: "info" | "success" | "warning" | "error" | "outline" }
> = {
  CREATED: { label: "접수됨", variant: "outline" },
  PLANNING: { label: "기획 중", variant: "info" },
  EXECUTING: { label: "구현 중", variant: "info" },
  VERIFYING: { label: "이종 검수", variant: "info" },
  AWAITING_APPROVAL: { label: "결재 대기", variant: "warning" },
  COMPLETED: { label: "완료", variant: "success" },
  FAILED: { label: "실패", variant: "error" },
  CANCELLED: { label: "중단됨", variant: "outline" },
};

export const CREW_STATUS_META: Record<
  MissionCrewStatus,
  {
    readonly label: string;
    readonly dotClass: string;
    readonly badgeVariant: "info" | "success" | "warning" | "error" | "outline";
  }
> = {
  IDLE: { label: "대기 중", dotClass: "bg-muted-foreground/50", badgeVariant: "outline" },
  WORKING: {
    label: "일하는 중",
    dotClass: "bg-emerald-500 animate-pulse",
    badgeVariant: "success",
  },
  BLOCKED: { label: "결재 대기", dotClass: "bg-amber-500", badgeVariant: "warning" },
  ERROR: { label: "오류", dotClass: "bg-destructive", badgeVariant: "error" },
  RATE_LIMITED: { label: "쿼터 제한", dotClass: "bg-amber-600", badgeVariant: "warning" },
};

export const DAG_STEP_STATUS_META: Record<
  MissionDagStepStatus,
  { readonly label: string; readonly variant: "info" | "success" | "warning" | "error" | "outline" }
> = {
  PENDING: { label: "대기", variant: "outline" },
  RUNNING: { label: "실행 중", variant: "info" },
  VERIFYING: { label: "검수 중", variant: "info" },
  AWAITING_APPROVAL: { label: "결재 대기", variant: "warning" },
  COMPLETED: { label: "완료", variant: "success" },
  FAILED: { label: "실패", variant: "error" },
  SKIPPED: { label: "생략", variant: "outline" },
};

export const MODEL_TIER_META: Record<
  MissionModelTier,
  { readonly label: string; readonly hint: string }
> = {
  TIER_S: { label: "Tier S (심층)", hint: "기획·설계·이종 검수" },
  TIER_A: { label: "Tier A (구현)", hint: "코드 작성·테스트" },
  TIER_B: { label: "Tier B (경량)", hint: "압축·요약·브리핑" },
};

export const ORG_TIER_META: Record<
  MissionOrgTier,
  {
    readonly short: string;
    readonly label: string;
    readonly hint: string;
    readonly variant: "info" | "success" | "warning" | "outline";
  }
> = {
  L0_COMMANDER: {
    short: "L0 지휘관",
    label: "L0 지휘관 (총괄 Main)",
    hint: "장기 목표·예산·최종 의사결정 통제",
    variant: "info",
  },
  L1_LEAD: {
    short: "L1 실장·리드",
    label: "L1 실장·리드 (기획/감사)",
    hint: "작업 분해·하위 배정·이종 교차 검증",
    variant: "success",
  },
  L2_SPECIALIST: {
    short: "L2 실무 전문가",
    label: "L2 실무 전문가 (구현/데이터)",
    hint: "격리 워크트리 구현·테스트·분석 (회의 시 상급자와 동등)",
    variant: "outline",
  },
  L3_SUPPORT: {
    short: "L3 지원·요약",
    label: "L3 지원·비서 (요약/문서)",
    hint: "경량 브리핑·보고서·문서화 (회의 시 상급자와 동등)",
    variant: "outline",
  },
};

export const EXECUTION_STYLE_META: Record<
  MissionExecutionStyle,
  { readonly label: string; readonly hint: string }
> = {
  hierarchical_ops: {
    label: "계층 자율 미션",
    hint: "L0/L1 지휘 → L2 구현 → 이종 검수 1사이클 완결",
  },
  persistent_goal: {
    label: "지속 목표 루프 (구 지속 작업실)",
    hint: "완료 조건·검증 명령 충족 전까지 체크포인트 단위로 지속 실행",
  },
};

export const MEETING_STYLE_META: Record<
  MissionMeetingStyle,
  { readonly label: string; readonly hint: string }
> = {
  roundtable: {
    label: "자유 동등 합석 대화",
    hint: "감독자 진행 · 나머지 전원 직급 무관 동등 대화 (하위자→상급자 직접 의견 전달)",
  },
  blind_audit: {
    label: "블라인드 교차 감사",
    hint: "1라운드 독립 격리 발의 → 2라운드 익명 교차 반론 → 감독자 통합",
  },
};

export const MEETING_STATUS_META: Record<
  MissionMeetingStatus,
  { readonly label: string; readonly variant: "info" | "success" | "warning" | "outline" }
> = {
  RUNNING: { label: "회의 진행 중", variant: "info" },
  CONSENSUS_REACHED: { label: "조기 합의 종료", variant: "success" },
  COMPLETED: { label: "회의 완료", variant: "success" },
  CANCELLED: { label: "회의 중단됨", variant: "outline" },
};

export const MEETING_STANCE_META: Record<
  MissionMeetingStance,
  { readonly label: string; readonly variant: "info" | "success" | "warning" | "error" | "outline" }
> = {
  propose: { label: "발의", variant: "info" },
  agree: { label: "동의", variant: "success" },
  partial_disagree: { label: "부분 보완", variant: "warning" },
  counter: { label: "반론·대안", variant: "error" },
  synthesize: { label: "감독자 종합", variant: "info" },
};

export const TRIGGER_REASON_LABELS: Record<MissionTriggerReason, string> = {
  DESTRUCTIVE_OP: "파괴적 작업 보호",
  EXTERNAL_SIDE_EFFECT: "외부 부수효과 보호",
  BUDGET_EXCEEDED: "예산/토큰 상한 도달",
  HOP_LIMIT: "교신 홉 상한(4회)",
  REWORK_LIMIT: "반려 재작업 상한(2회)",
  REPEAT_ERROR_HASH: "동일 에러 2회 반복",
  STALL_LOOP: "반복 정체 감지(≥85%)",
  CHECKER_CONFLICT: "검수 의견 충돌/확인",
  SYNC_MEETING_DECISION: "회의 합의 결재",
  ORPHAN_RECOVERY: "재시작 복구 확인",
  FINAL_MERGE_CONFIRM: "최종 승인 및 반영",
};

export const CIRCUIT_BREAKER_META: Record<
  MissionCircuitBreakerState,
  { readonly label: string; readonly variant: "success" | "warning" | "error" }
> = {
  OK: { label: "가드레일 정상", variant: "success" },
  THROTTLED: { label: "12K 자동 압축", variant: "warning" },
  TRIPPED_TO_INBOX: { label: "서킷 브레이크", variant: "error" },
};

export interface QuickMissionPreset {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly goalPrompt: string;
  readonly doneCriteria: ReadonlyArray<string>;
}

export const QUICK_MISSION_PRESETS: ReadonlyArray<QuickMissionPreset> = [
  {
    id: "bugfix",
    label: "버그 원인 분석·수정",
    title: "핵심 버그 원인 분석 및 최소 패치",
    goalPrompt:
      "최근 오류나 테스트 실패 원인을 최소 범위로 분석하고, 격리 워크트리에서 수정 및 단위 테스트로 검증해 줘.",
    doneCriteria: ["원인 및 재현 조건 3줄 요약", "최소 범위 코드 수정", "관련 단위 테스트 통과"],
  },
  {
    id: "audit",
    label: "회귀·보안 교차 감사",
    title: "최근 변경 회귀·보안 교차 감사",
    goalPrompt:
      "현재 저장소의 최근 변경 사항을 이종 모델 관점에서 회귀 위험, 보안 취약점, 엣지 케이스 중심으로 점검해 줘.",
    doneCriteria: ["심각도별 이슈 목록 정리", "재현 가능한 근거 파일·라인 제시"],
  },
  {
    id: "tests",
    label: "테스트 보강",
    title: "핵심 경계값 단위 테스트 보강",
    goalPrompt:
      "핵심 모듈의 누락된 경계값과 실패 경로에 대한 단위 테스트를 추가하고 통과 여부를 확인해 줘.",
    doneCriteria: ["신규 테스트 케이스 추가", "기존·신규 테스트 전체 통과"],
  },
  {
    id: "docs",
    label: "운영 보고·문서 동기화",
    title: "현재 상태 점검 및 문서 동기화",
    goalPrompt:
      "현재 프로젝트의 주요 변경 사항과 운영 상태를 점검하고 3줄 경영 요약과 문서 업데이트 포인트를 정리해 줘.",
    doneCriteria: ["현황 3줄 요약", "누락/불일치 항목 목록"],
  },
];

export function formatRelativeTimeKo(timestampMs: number | null | undefined): string {
  if (!timestampMs) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 10) return "방금";
  if (diffSec < 60) return `${diffSec}초 전`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  return new Date(timestampMs).toLocaleDateString("ko-KR");
}

export function formatClockTimeKo(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

export function filterMissionsByStatus(
  missions: ReadonlyArray<MissionRun>,
  filter: "all" | "active" | "approval" | "completed",
): ReadonlyArray<MissionRun> {
  if (filter === "all") return missions;
  if (filter === "active") {
    return missions.filter(
      (m) =>
        m.status === "CREATED" ||
        m.status === "PLANNING" ||
        m.status === "EXECUTING" ||
        m.status === "VERIFYING",
    );
  }
  if (filter === "approval") {
    return missions.filter((m) => m.status === "AWAITING_APPROVAL");
  }
  return missions.filter((m) => m.status === "COMPLETED");
}

export function findCrewDisplayName(
  roles: ReadonlyArray<MissionCrewRole>,
  roleKey: string | null | undefined,
): string {
  if (!roleKey) return "자율 운영실";
  return roles.find((r) => r.roleKey === roleKey)?.displayName ?? roleKey;
}
