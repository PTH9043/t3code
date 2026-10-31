import { HandoffSettings } from "./HandoffSettings";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatTokenCount,
  tokenUsageCountLabels,
  tokenUsageIssueLabel,
  tokenUsagePhaseLabel,
  tokenUsageSummary,
  tokenUsageOutcomeLabel,
  tokenUsageDiagnosticRows,
} from "@t3tools/client-runtime/state/token-usage";
import { useEffect, useRef, useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function TokenUsageButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  busy: boolean;
}) {
  const [workId, setWorkId] = useState<string | undefined>();
  const [beforeSequence, setBeforeSequence] = useState<number | undefined>();
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadTokenUsage({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        ...(workId ? { workId } : {}),
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      },
    }),
  );
  const lastBusy = useRef(props.busy);
  useEffect(() => {
    if (lastBusy.current !== props.busy) {
      lastBusy.current = props.busy;
      query.refresh();
    }
  }, [props.busy, query.refresh]);
  const report = query.data;
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) query.refresh();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="작업 토큰 사용량 상세"
            className="max-w-40 truncate rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent focus-visible:outline-ring"
          >
            {query.error ? "사용량 조회 실패" : tokenUsageSummary(report)}
          </button>
        }
      />
      <PopoverPopup side="top" align="end" className="w-[min(440px,calc(100vw-24px))] p-4">
        <div className="max-h-[65vh] space-y-3 overflow-y-auto text-xs">
          <div className="flex items-center justify-between gap-3">
            <strong>작업 토큰 사용량</strong>
            <button
              type="button"
              className="underline"
              onClick={query.refresh}
              disabled={query.isPending}
            >
              {query.isPending ? "갱신 중" : "새로고침"}
            </button>
          </div>
          {query.error ? (
            <p role="alert" className="text-destructive">
              {query.error}
            </p>
          ) : null}
          <HandoffSettings {...props} />
          {!query.error && report ? (
            <>
              {report.recentWorks.length > 0 ? (
                <label className="grid gap-1">
                  <span>작업 선택</span>
                  <select
                    className="w-full rounded border bg-background p-2"
                    value={report.work?.workId ?? ""}
                    onChange={(event) => setWorkId(event.target.value)}
                  >
                    {report.recentWorks.map((work) => (
                      <option key={work.workId} value={work.workId}>
                        {new Date(work.requestedAt).toLocaleString("ko-KR")}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="flex gap-3">
                {beforeSequence !== undefined ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setBeforeSequence(undefined);
                      setWorkId(undefined);
                    }}
                  >
                    최근 작업
                  </button>
                ) : null}
                {report.nextBeforeSequence !== null ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setBeforeSequence(report.nextBeforeSequence!);
                      setWorkId(undefined);
                    }}
                  >
                    이전 작업
                  </button>
                ) : null}
              </div>
              {report.coverage === "before-collection" ? (
                <p>계측 이전 기록입니다. 과거 사용량은 복원하지 않습니다.</p>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
                    {tokenUsageCountLabels.map(({ key, label }) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="text-right">{formatTokenCount(report.counts[key])}</dd>
                      </div>
                    ))}
                  </dl>
                  <p>
                    {tokenUsageOutcomeLabel[report.outcome]} ·{" "}
                    {report.finality === "final" ? "보고 종료" : "잠정 집계"} · 품질 판정 별도
                  </p>
                  <dl className="grid grid-cols-2 gap-2 rounded-md border border-border p-2">
                    {tokenUsageDiagnosticRows(report).map((row) => (
                      <div key={row.label} className="contents">
                        <dt>{row.label}</dt>
                        <dd className="text-right tabular-nums">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {report.breakdown.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <caption className="mb-2 text-left font-medium">
                          모델·단계·시도별 확인된 사용량
                        </caption>
                        <thead>
                          <tr>
                            <th>모델 / 제공자</th>
                            <th>단계</th>
                            <th className="text-right">토큰</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.breakdown.map((row) => (
                            <tr key={`${row.provider}:${row.model}:${row.phase}:${row.attempt}`}>
                              <td className="max-w-52 break-words py-2 pr-2">
                                {row.model}
                                <span className="block text-muted-foreground">{row.provider}</span>
                              </td>
                              <td className="pr-2">
                                {tokenUsagePhaseLabel[row.phase]}
                                {row.attempt > 1 ? ` · 재시도 ${row.attempt - 1}` : ""}
                              </td>
                              <td className="text-right tabular-nums">
                                {formatTokenCount(row.counts.total)}
                                {row.issues.length ? " *" : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </>
              )}
              {report.issues.map((issue) => (
                <p key={issue} className="text-muted-foreground">
                  {tokenUsageIssueLabel[issue]}
                </p>
              ))}
              <p className="text-muted-foreground">
                캐시·추론은 입력·출력에 포함됩니다. —는 미보고이며, 항목별 숫자는 보고된 범위의
                합입니다. 모델은 실행 요청 당시 선택값입니다.
              </p>
              <p className="text-muted-foreground">
                계측 시작: {new Date(report.collectedSince).toLocaleString("ko-KR")}
              </p>
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
