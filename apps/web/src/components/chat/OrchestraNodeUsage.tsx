import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatTokenCount,
  tokenUsageCountLabels,
  tokenUsageDiagnosticRows,
  tokenUsageIssueLabel,
} from "@t3tools/client-runtime/state/token-usage";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

interface Props {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  runId: string;
  nodeId: string;
  busy: boolean;
}

/** Query only on an explicit disclosure, so a large graph never makes one request per row. */
export function OrchestraNodeUsage(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <button
        type="button"
        className="underline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        이 단계의 토큰 사용량 {open ? "접기" : "보기"}
      </button>
      {open ? <NodeUsageReport {...props} /> : null}
    </div>
  );
}

function NodeUsageReport(props: Props) {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadTokenUsage({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, workId: `run:${props.runId}`, nodeId: props.nodeId },
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
    <div className="mt-2 space-y-2">
      <button
        type="button"
        className="underline"
        onClick={query.refresh}
        disabled={query.isPending}
      >
        {query.isPending ? "조회 중" : "사용량 새로고침"}
      </button>
      {query.error ? (
        <p role="alert" className="text-destructive">
          {query.error}
        </p>
      ) : null}
      {report ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
            {tokenUsageCountLabels.map(({ key, label }) => (
              <div key={key} className="contents">
                <dt>{label}</dt>
                <dd className="text-right">{formatTokenCount(report.counts[key])}</dd>
              </div>
            ))}
          </dl>
          <p>
            {report.finality === "final" ? "보고 종료" : "잠정 집계"} · 이 단계의 모든 시도 합계
          </p>
          <dl className="grid grid-cols-2 gap-1 tabular-nums">
            {tokenUsageDiagnosticRows(report).map((row) => (
              <div key={row.label} className="contents">
                <dt>{row.label}</dt>
                <dd className="text-right">{row.value}</dd>
              </div>
            ))}
          </dl>
          {report.issues.map((issue) => (
            <p key={issue}>{tokenUsageIssueLabel[issue]}</p>
          ))}
          <p className="text-muted-foreground">
            제공자가 보고한 사용량입니다. —는 미보고이며, 캐시·추론은 입력·출력에 포함됩니다. 전체
            작업 사용량에는 이 단계가 이미 포함되어 있습니다.
          </p>
        </>
      ) : null}
    </div>
  );
}
