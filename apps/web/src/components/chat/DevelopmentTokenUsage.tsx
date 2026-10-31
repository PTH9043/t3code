import type { DevelopmentUsage, TokenUsageSummary } from "@t3tools/contracts";

const count = (value: number | null | undefined) =>
  value == null ? "미집계" : value.toLocaleString();
function UsageRow({
  title,
  usage,
  limit,
}: {
  title: string;
  usage: TokenUsageSummary | null | undefined;
  limit: number | null | undefined;
}) {
  const used = usage?.counts.total;
  const warning = used != null && limit != null && used >= limit * 0.8;
  return (
    <div className="space-y-1">
      <p className={warning ? "font-medium text-amber-600 dark:text-amber-400" : "font-medium"}>
        {title}: {usage?.requestCount === 0 ? "사용 전" : count(used)} 토큰
        {limit != null ? ` / ${limit.toLocaleString()}` : " · 예산 미설정"}
        {warning ? (used >= limit! ? " · 예산 도달" : " · 예산 80% 이상") : ""}
      </p>
      {usage && usage.requestCount > 0 && (
        <p className="text-muted-foreground">
          입력 {count(usage.counts.input)} · 출력 {count(usage.counts.output)} · 캐시 읽기{" "}
          {count(usage.counts.cacheRead)}
          {` · 보고된 실행 ${usage.reportedRequestCount}/${usage.requestCount}개`}
          {usage.coverage !== "reported" || usage.inProgress ? " · 일부 사용량 미확정" : ""}
        </p>
      )}
      {!!usage?.breakdown.length && (
        <details className="text-muted-foreground">
          <summary>AI·단계·시도별 사용량</summary>
          {usage.breakdown.map((row) => (
            <p key={JSON.stringify([row.provider, row.model, row.phase, row.attempt])}>
              {row.model} · {row.phase} · 시도 {row.attempt}: {count(row.counts.total)} 토큰
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

export function DevelopmentTokenUsage({
  usage,
  maxTokens,
  maxDailyTokens,
  hasGoal,
}: {
  usage: DevelopmentUsage | undefined;
  maxTokens: number | null | undefined;
  maxDailyTokens: number | null | undefined;
  hasGoal: boolean;
}) {
  return (
    <div className="mt-2 space-y-2 rounded border p-2 text-xs" aria-label="자동 개발 토큰 사용량">
      {hasGoal && (
        <UsageRow
          title="현재 목표 · Main·담당 AI·재시도 합산"
          usage={usage?.goal}
          limit={maxTokens}
        />
      )}
      <UsageRow
        title="프로젝트 오늘 · 서버 날짜 기준"
        usage={usage?.daily}
        limit={maxDailyTokens}
      />
      <p className="text-muted-foreground">
        예산은 보고된 사용량을 기준으로 새 자동 작업 시작 전에 적용됩니다. 진행 중 응답과 늦게
        보고된 사용량으로 초과할 수 있습니다. 캐시 읽기는 입력의 일부입니다.
      </p>
    </div>
  );
}
