import type {
  ThreadTokenUsageReport,
  TokenCounts,
  TokenUsageIssue,
  TokenUsagePhase,
} from "@t3tools/contracts";

const exact = new Intl.NumberFormat("ko-KR");
const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
export function formatTokenCount(count: number | null | undefined, abbreviated = false): string {
  return count == null ? "—" : (abbreviated ? compact : exact).format(count);
}
export const tokenUsagePhaseLabel: Record<TokenUsagePhase, string> = {
  general: "일반",
  discussion: "회의",
  planning: "계획",
  implementation: "구현",
  verification: "검증",
  finalization: "정리",
  "format-repair": "형식 복구",
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
  { key: "cacheWrite5m", label: "캐시 쓰기 중 5분" },
  { key: "cacheWrite1h", label: "캐시 쓰기 중 1시간" },
  { key: "reasoning", label: "출력 중 추론" },
];
export function tokenUsageSummary(report: ThreadTokenUsageReport | null): string {
  if (report === null) return "사용량 조회 중";
  if (report.coverage === "before-collection") return "사용량 · 계측 이전";
  if (report.coverage === "unavailable")
    return report.inProgress ? "사용량 보고 대기" : "사용량 미보고";
  return `작업 ${formatTokenCount(report.counts.total, true)} 토큰${report.coverage === "partial" ? " · 일부" : ""}`;
}

/** Ratios use only rows whose numerator and denominator were actually reported. */
export function tokenUsageDiagnostics(
  report: Pick<ThreadTokenUsageReport, "counts" | "breakdown">,
) {
  const cacheKnown =
    report.breakdown.length > 0 &&
    report.breakdown.every(
      (row) =>
        row.counts.input !== null &&
        row.counts.cacheRead !== null &&
        row.counts.cacheRead <= row.counts.input,
    );
  const cacheReadShare =
    cacheKnown &&
    report.counts.input !== null &&
    report.counts.input > 0 &&
    report.counts.cacheRead !== null &&
    report.counts.cacheRead <= report.counts.input
      ? report.counts.cacheRead / report.counts.input
      : null;
  const measuredTotal = (
    predicate: (row: ThreadTokenUsageReport["breakdown"][number]) => boolean,
  ) => {
    const rows = report.breakdown.filter(predicate);
    if (rows.length === 0 || rows.some((row) => row.counts.total === null)) return null;
    return rows.reduce((total, row) => total + (row.counts.total ?? 0), 0);
  };
  return {
    cacheReadShare,
    verificationTokens: measuredTotal((row) => row.phase === "verification"),
    retryTokens: measuredTotal((row) => row.attempt > 1),
    formatRepairTokens: measuredTotal((row) => row.phase === "format-repair"),
  };
}

export function tokenUsageDiagnosticRows(
  report: Pick<ThreadTokenUsageReport, "counts" | "breakdown">,
) {
  const diagnostics = tokenUsageDiagnostics(report);
  return [
    {
      label: "보고된 입력의 캐시 재사용률",
      value:
        diagnostics.cacheReadShare === null
          ? "—"
          : `${(diagnostics.cacheReadShare * 100).toFixed(1)}%`,
    },
    { label: "검증 단계 토큰", value: formatTokenCount(diagnostics.verificationTokens) },
    { label: "재시도 토큰", value: formatTokenCount(diagnostics.retryTokens) },
    { label: "형식 복구 토큰", value: formatTokenCount(diagnostics.formatRepairTokens) },
  ];
}
import { InputCompositionReport, type OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeInputComposition = Schema.decodeUnknownOption(InputCompositionReport);
export function latestInputComposition(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index]!;
    if (activity.kind !== "input.composition.prepared") continue;
    const parsed = decodeInputComposition(activity.payload);
    if (parsed._tag === "Some") return { createdAt: activity.createdAt, report: parsed.value };
  }
  return null;
}
export function inputCompositionText(report: InputCompositionReport): string {
  return `최근 AI 입력 준비 ${report.promptChars.toLocaleString("ko-KR")}자 · 첨부 ${report.attachmentCount}개. CLI 내부 문맥과 실제 사용 토큰은 별도입니다.`;
}
