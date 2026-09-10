import type {
  ThreadTokenUsageReport,
  TokenCounts,
  TokenUsageIssue,
  TokenUsagePhase,
} from "@t3tools/contracts";

const exact = new Intl.NumberFormat("ko-KR");
const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
export function formatTokenCount(count: number | null, abbreviated = false): string {
  return count === null ? "—" : (abbreviated ? compact : exact).format(count);
}
export const tokenUsagePhaseLabel: Record<TokenUsagePhase, string> = {
  general: "일반",
  discussion: "회의",
  planning: "계획",
  implementation: "구현",
  verification: "검증",
  finalization: "정리",
};
export const tokenUsageIssueLabel: Record<TokenUsageIssue, string> = {
  "final-usage-unconfirmed": "제공자의 최종 사용량이 확인되지 않아 잠정 집계입니다.",
  "baseline-required": "첫 누적 보고는 기준점으로 저장했습니다. 그 이전 사용량은 제외됩니다.",
  "counter-regressed": "누적 카운터가 감소한 구간은 합산을 보류했습니다.",
  unreported: "보고되지 않은 실행이 있습니다. 숫자는 확인된 부분합입니다.",
  "native-child-coverage-unknown":
    "내장 하위 에이전트의 포함 범위가 확인되지 않아 별도로 더하지 않았습니다.",
};
export const tokenUsageOutcomeLabel: Record<ThreadTokenUsageReport["outcome"], string> = {
  running: "실행 중",
  completed: "실행 종료",
  failed: "실패",
  interrupted: "중단",
  unknown: "미확인",
};
export const tokenUsageCountLabels: ReadonlyArray<{ key: keyof TokenCounts; label: string }> = [
  { key: "total", label: "총 토큰" },
  { key: "input", label: "입력" },
  { key: "output", label: "출력" },
  { key: "cacheRead", label: "입력 중 캐시 읽기" },
  { key: "cacheWrite", label: "입력 중 캐시 쓰기" },
  { key: "reasoning", label: "출력 중 추론" },
];
export function tokenUsageSummary(report: ThreadTokenUsageReport | null): string {
  if (report === null) return "사용량 조회 중";
  if (report.coverage === "before-collection") return "사용량 · 계측 이전";
  if (report.coverage === "unavailable")
    return report.inProgress ? "사용량 보고 대기" : "사용량 미보고";
  return `작업 ${formatTokenCount(report.counts.total, true)} 토큰${report.coverage === "partial" ? " · 일부" : ""}`;
}
