import type {
  DevelopmentGoal,
  ThreadTokenUsageReport,
  TokenUsageSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function developmentUsageSummary(report: ThreadTokenUsageReport): TokenUsageSummary {
  return {
    counts: report.counts,
    breakdown: report.breakdown,
    issues: report.issues,
    coverage: report.coverage,
    inProgress: report.inProgress,
    requestCount: report.requestCount ?? report.breakdown.length,
    reportedRequestCount:
      report.reportedRequestCount ??
      report.breakdown.filter((row) => row.counts.total !== null).length,
  };
}

export const developmentGoalWorkId = (goal: Pick<DevelopmentGoal, "id">) =>
  `development-goal:${goal.id}`;

/** The server's local calendar day; the clock is supplied by the caller. */
export function developmentUsageDay(
  timestamp: string,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  return DateTime.formatIso(
    DateTime.startOf(DateTime.makeZonedUnsafe(timestamp, { timeZone }), "day"),
  );
}

export function developmentTokenBudgetStatus(
  usage: TokenUsageSummary | null | undefined,
  limit: number | null | undefined,
) {
  if (limit == null) return "unlimited";
  if (usage?.requestCount === 0) return "within";
  const measured = usage?.counts.total;
  if (measured == null) return "unreported";
  if (measured >= limit) return "exceeded";
  return measured >= limit * 0.8 ? "warning" : "within";
}

export function developmentTokenBudgetLimit(input: {
  goal?: TokenUsageSummary | null | undefined;
  daily?: TokenUsageSummary | null | undefined;
  maxTokens?: number | null | undefined;
  maxDailyTokens?: number | null | undefined;
}) {
  if (developmentTokenBudgetStatus(input.goal, input.maxTokens) === "exceeded")
    return "목표의 보고된 토큰 예산에 도달했습니다. 새 자동 작업을 중단합니다.";
  if (developmentTokenBudgetStatus(input.daily, input.maxDailyTokens) === "exceeded")
    return "프로젝트의 일일 보고된 토큰 예산에 도달했습니다. 새 자동 작업을 중단합니다.";
  return null;
}
