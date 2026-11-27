import type { WorkspaceKnowledgeDashboard } from "@t3tools/contracts";
import { kindLabels, statusLabels, number } from "./dashboardPresentation";

function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l-2 border-primary/40 pl-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
export function KnowledgeMetrics({ data }: { data: WorkspaceKnowledgeDashboard }) {
  const c = data.compaction;
  return (
    <section aria-label="프로젝트 지식 통계" className="space-y-4">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Count label="전체 문서" value={number.format(data.total)} />
        <Count label="분류 대기" value={number.format(data.candidates.total)} />
        <Count label="한 번도 사용하지 않음" value={number.format(data.unused.total)} />
        <Count
          label="전체 글자 감소율"
          value={
            c.reductionRatio === null
              ? "측정값 없음"
              : new Intl.NumberFormat("ko-KR", {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(c.reductionRatio)
          }
        />
      </dl>
      <div className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <h2 className="mb-2 text-sm font-semibold">종류별 문서</h2>
          <dl className="space-y-1">
            {data.byKind.map(({ kind, count }) => (
              <div key={kind} className="flex justify-between gap-3 text-xs">
                <dt>{kindLabels[kind]}</dt>
                <dd className="tabular-nums">{number.format(count)}</dd>
              </div>
            ))}
          </dl>
          {!data.byKind.length && <p className="text-xs text-muted-foreground">문서 없음</p>}
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold">상태별 문서</h2>
          <dl className="space-y-1">
            {data.byStatus.map(({ status, count }) => (
              <div key={status} className="flex justify-between gap-3 text-xs">
                <dt>{statusLabels[status]}</dt>
                <dd className="tabular-nums">{number.format(count)}</dd>
              </div>
            ))}
          </dl>
          {!data.byStatus.length && <p className="text-xs text-muted-foreground">문서 없음</p>}
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold">압축 총계</h2>
          <p className="text-xs leading-5">
            측정 문서 {number.format(c.measuredItems)}개<br />
            원본 {number.format(c.originalChars)}자 → 저장 {number.format(c.storedChars)}자
          </p>
        </div>
      </div>
      <details className="rounded-lg border border-border px-4 py-2">
        <summary className="cursor-pointer text-sm font-medium">일별 문서 증가 (UTC)</summary>
        {data.growth.length ? (
          <div className="mt-2 max-h-48 overflow-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead>
                <tr>
                  <th scope="col">생성일</th>
                  <th scope="col" className="text-right">
                    생성 문서
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.growth.map(({ day, count }) => (
                  <tr key={day}>
                    <td>{day}</td>
                    <td className="text-right">{number.format(count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">기록 없음</p>
        )}
      </details>
    </section>
  );
}
