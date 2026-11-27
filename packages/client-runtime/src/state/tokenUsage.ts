import type {
  ServerProviderUsage,
  ServerProviderUsageWindow,
  ThreadTokenUsageReport,
  TokenCounts,
  TokenUsageIssue,
  TokenUsagePhase,
} from "@t3tools/contracts";

const exact = new Intl.NumberFormat("ko-KR");
const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
const quotaResetFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export interface QuotaWindowDisplay {
  readonly id: string;
  readonly bucket?: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly usedPercent: number;
  readonly percentText: string;
  readonly resetsAt?: number;
  readonly resetText?: string;
}

export function formatQuotaPercent(usedPercent: number): string {
  const clamped = Math.min(100, Math.max(0, usedPercent));
  return `${clamped.toFixed(clamped % 1 === 0 ? 0 : 1)}%`;
}

export function quotaWindowLabel(window: ServerProviderUsageWindow, fallback: string): string {
  if (window.label) return window.label;
  if (window.windowDurationMinutes === 300) return "5시간";
  if (window.windowDurationMinutes === 10_080) return "7일";
  return fallback;
}

export function quotaWindowShortLabel(window: ServerProviderUsageWindow, fallback: string): string {
  if (window.bucket && window.label) return window.label;
  if (window.windowDurationMinutes === 300) return "5시간";
  if (window.windowDurationMinutes === 10_080) return "7일";
  return window.label ?? fallback;
}

export function formatQuotaResetTime(resetsAt: number | undefined): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
  return `${quotaResetFormatter.format(resetsAt * 1_000)} 초기화`;
}

function toQuotaDisplay(
  id: string,
  window: ServerProviderUsageWindow,
  fallbackLabel: string,
  fallbackShortLabel: string,
): QuotaWindowDisplay {
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  const resetText = formatQuotaResetTime(window.resetsAt);
  return {
    id,
    ...(window.bucket ? { bucket: window.bucket } : {}),
    label: quotaWindowLabel(window, fallbackLabel),
    shortLabel: quotaWindowShortLabel(window, fallbackShortLabel),
    usedPercent,
    percentText: formatQuotaPercent(usedPercent),
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    ...(resetText ? { resetText } : {}),
  };
}

function modelMatchesBucket(model: string, bucket: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedBucket = bucket.trim().toLowerCase();
  if (!normalizedModel || !normalizedBucket) return false;
  if (normalizedBucket === "claude-gpt") {
    return normalizedModel.includes("claude") || normalizedModel.includes("gpt");
  }
  return normalizedModel.includes(normalizedBucket);
}

/**
 * Extract reported subscription quota windows (5-hour, 7-day, and any bucket-scoped
 * extra windows such as Antigravity's Claude & GPT bucket).
 *
 * - `includeExtra: true`: returns every window (for Settings, Control Center, and popovers).
 * - `model`: when provided without `includeExtra`, prefers windows whose `bucket` matches
 *   the active model (e.g. Claude·GPT bucket when running a Claude/GPT model on Antigravity).
 */
export function providerQuotaWindows(
  usage: ServerProviderUsage | undefined,
  options?: {
    readonly model?: string | null | undefined;
    readonly includeExtra?: boolean | undefined;
  },
): ReadonlyArray<QuotaWindowDisplay> {
  if (!usage) return [];
  const main: QuotaWindowDisplay[] = [];
  if (usage.primary) {
    main.push(toQuotaDisplay("primary", usage.primary, "단기 한도", "5시간"));
  }
  if (usage.secondary) {
    main.push(toQuotaDisplay("secondary", usage.secondary, "장기 한도", "7일"));
  }
  const extra: QuotaWindowDisplay[] = (usage.extraWindows ?? []).map((window, index) =>
    toQuotaDisplay(
      `extra-${window.bucket ?? "bucket"}-${index}`,
      window,
      window.windowDurationMinutes === 300 ? "단기 한도" : "장기 한도",
      window.windowDurationMinutes === 300 ? "5시간" : "7일",
    ),
  );
  if (options?.includeExtra) {
    return [...main, ...extra];
  }
  const activeModel = options?.model?.trim();
  if (activeModel && extra.length > 0) {
    const matchedExtra = extra.filter(
      (window) => window.bucket !== undefined && modelMatchesBucket(activeModel, window.bucket),
    );
    if (matchedExtra.length > 0) return matchedExtra;
  }
  return main.length > 0 ? main : extra;
}

export function providerQuotaSummary(
  usage: ServerProviderUsage | undefined,
  options?: {
    readonly model?: string | null | undefined;
    readonly includeExtra?: boolean | undefined;
  },
): string | null {
  const windows = providerQuotaWindows(usage, options);
  if (windows.length === 0) return null;
  return windows.map((window) => `${window.shortLabel} ${window.percentText}`).join(" · ");
}
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

export interface TokenUsageEfficiencyDiagnostics {
  readonly weightedInputTokens: number | null;
  readonly reasoningOutputShare: number | null;
  readonly cacheHealth: "healthy" | "warning" | "unknown";
  readonly cacheWarningMessage: string | null;
}

/**
 * Estimates provider-weighted input-equivalent token spend `W_m` and surfaces
 * cache-prefix health (< 50% cache hit warning) and reasoning output share.
 */
export function tokenUsageEfficiencyDiagnostics(
  report: Pick<ThreadTokenUsageReport, "counts" | "breakdown">,
): TokenUsageEfficiencyDiagnostics {
  const base = tokenUsageDiagnostics(report);
  const counts = report.counts;
  const reasoningOutputShare =
    counts.output !== null &&
    counts.output > 0 &&
    counts.reasoning !== null &&
    counts.reasoning >= 0
      ? Math.min(1, counts.reasoning / counts.output)
      : null;

  const cacheHealth: TokenUsageEfficiencyDiagnostics["cacheHealth"] =
    base.cacheReadShare === null
      ? "unknown"
      : base.cacheReadShare < 0.5 && (counts.input ?? 0) >= 4_000
        ? "warning"
        : "healthy";

  const cacheWarningMessage =
    cacheHealth === "warning"
      ? `캐시 재사용률(${(base.cacheReadShare! * 100).toFixed(1)}%)이 50% 미만입니다. 프리픽스 변동·장문 매턴 재주입 여부를 점검하세요.`
      : null;

  let weightedInputTokens: number | null = null;
  if (counts.input !== null) {
    const primaryProvider = (report.breakdown[0]?.provider ?? "").toLowerCase();
    const isClaude = primaryProvider.includes("claude");
    const isGemini = primaryProvider.includes("gemini");
    const alpha5m = isClaude ? 1.25 : 1.0;
    const alpha1h = isClaude ? 2.0 : 1.0;
    const beta = isClaude ? 0.1 : isGemini ? 0.25 : 0.25;
    const gamma = isClaude ? 5.0 : 5.0;

    const cacheRead = counts.cacheRead ?? 0;
    const cw5m = counts.cacheWrite5m ?? counts.cacheWrite ?? 0;
    const cw1h = counts.cacheWrite1h ?? 0;
    const uncachedInput = Math.max(0, counts.input - cacheRead - cw5m - cw1h);
    const outputAndReasoning = (counts.output ?? 0) + (counts.reasoning ?? 0);
    weightedInputTokens = Math.round(
      uncachedInput +
        alpha5m * cw5m +
        alpha1h * cw1h +
        beta * cacheRead +
        gamma * outputAndReasoning,
    );
  }

  return {
    weightedInputTokens,
    reasoningOutputShare,
    cacheHealth,
    cacheWarningMessage,
  };
}

export function tokenUsageDiagnosticRows(
  report: Pick<ThreadTokenUsageReport, "counts" | "breakdown">,
) {
  const diagnostics = tokenUsageDiagnostics(report);
  const efficiency = tokenUsageEfficiencyDiagnostics(report);
  return [
    {
      label: "보고된 입력의 캐시 재사용률",
      value:
        diagnostics.cacheReadShare === null
          ? "—"
          : `${(diagnostics.cacheReadShare * 100).toFixed(1)}%${efficiency.cacheHealth === "warning" ? " (주의)" : ""}`,
    },
    {
      label: "입력 등가 가중 토큰 (W_m)",
      value: formatTokenCount(efficiency.weightedInputTokens, true),
    },
    {
      label: "출력 중 추론(Reasoning) 비중",
      value:
        efficiency.reasoningOutputShare === null
          ? "—"
          : `${(efficiency.reasoningOutputShare * 100).toFixed(1)}%`,
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
