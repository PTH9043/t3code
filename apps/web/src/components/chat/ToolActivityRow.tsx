import { useContext, useEffect, useEffectEvent, useState } from "react";
import { buildToolActivityFacts } from "@t3tools/shared/toolActivity";
import {
  toolEvidenceLabel,
  toolEventLabel,
  toolPhaseLabel,
  type ThreadToolActivity,
} from "@t3tools/client-runtime/state/thread-tool-activity";
import {
  ActivityDiffContext,
  ActivityRecordContext,
  ActivitySummaryContext,
} from "./ActivitySummaryProvider";
import { maskedActivityRecord } from "@t3tools/client-runtime/state/thread-tool-activity";

function formatDurationCompact(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 100) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}초`;
}

function hasStructuredPreview(group: ThreadToolActivity): boolean {
  const p = group.preview;
  return Boolean(p?.intent || p?.editSummary || p?.outputSnippet || p?.lineRange || p?.searchQuery);
}

function ActivityExplanation({ group }: { group: ThreadToolActivity }) {
  const readSummary = useContext(ActivitySummaryContext);
  const richPreview = hasStructuredPreview(group);
  const [manualSummaryRequested, setManualSummaryRequested] = useState(false);
  const request =
    group.commandFailureNote || (richPreview && !manualSummaryRequested) ? null : readSummary;
  const records = useContext(ActivityRecordContext);
  const [showRecords, setShowRecords] = useState(false);
  const diff = useContext(ActivityDiffContext);
  const checkpoint = group.turnId && diff ? diff.ready.get(group.turnId) : undefined;
  const key = JSON.stringify([group.id, buildToolActivityFacts([group])[0]]);
  const load = useEffectEvent(() => request?.(group));
  const [received, setReceived] = useState<{
    key: string;
    request: typeof request;
    answer: { summary: string; model: string } | null;
  } | null>(null);
  const settled = received?.key === key && received.request === request ? received : null;
  const answer = settled?.answer;
  useEffect(() => {
    let live = true;
    void load()?.then((value) => {
      if (live)
        setReceived({
          key,
          request,
          answer:
            value?.summary && value.model ? { summary: value.summary, model: value.model } : null,
        });
    });
    return () => {
      live = false;
    };
  }, [request, key]);
  const preview = group.preview;
  const durationLabel = formatDurationCompact(preview?.durationMs);
  return (
    <div className="grid gap-2 border-l border-border pl-3 pb-1 text-xs">
      <p>{group.commandFailureNote ?? group.summary}</p>
      {preview?.intent && (
        <p className="text-foreground">
          작업 목적 · {preview.intent}
          {durationLabel ? ` (${durationLabel})` : ""}
        </p>
      )}
      {preview?.commandSnippet && (
        <div className="rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] break-all text-foreground/90">
          {preview.commandSnippet}
        </div>
      )}
      {preview?.editSummary?.excerpt && (
        <p className="rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] break-all text-muted-foreground">
          핵심 변경 · {preview.editSummary.excerpt}
        </p>
      )}
      {preview?.outputSnippet && (
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground/85">
          {preview.outputSnippet}
        </pre>
      )}
      <p className="text-muted-foreground">
        작업자 · {group.executorLabel} · 근거 · {toolEvidenceLabel[group.evidence]}
        {!preview?.intent && durationLabel ? ` · ${durationLabel}` : ""}
      </p>
      {group.targetPaths.length > 0 && (
        <p className="break-all">작업 대상 · {group.targetPaths.join(", ")}</p>
      )}
      {group.confirmedDiffPaths.length > 0 && (
        <div>
          <p>확인된 변경 파일</p>
          <ul>
            {group.confirmedDiffPaths.map((path) => (
              <li key={path}>
                {checkpoint?.files.some((f) => f.path === path) && diff ? (
                  <button
                    type="button"
                    className="break-all underline"
                    onClick={() => diff.open(checkpoint.turnId, path)}
                  >
                    {path} · 이 파일의 턴 차이 보기
                  </button>
                ) : (
                  path
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {checkpoint && diff && (
        <button
          type="button"
          className="w-fit underline"
          onClick={() => diff.open(checkpoint.turnId)}
        >
          이 턴 전체의 변경 차이 보기 ({checkpoint.files.length}개 파일)
        </button>
      )}
      {richPreview && readSummary && !manualSummaryRequested && !group.commandFailureNote && (
        <button
          type="button"
          className="w-fit text-[11px] text-muted-foreground underline hover:text-foreground"
          onClick={() => setManualSummaryRequested(true)}
        >
          로컬 AI 설명 보기
        </button>
      )}
      {request && !settled && (
        <span role="status" className="text-muted-foreground">
          로컬 설명 작성 중
        </span>
      )}
      {answer && (
        <div>
          <p>{answer.summary}</p>
          <p className="text-muted-foreground">요약자 · {answer.model}</p>
        </div>
      )}
      <details onToggle={(e) => setShowRecords(e.currentTarget.open)}>
        <summary className="cursor-pointer text-muted-foreground">
          원본 기술 기록 {group.events.length}건
        </summary>
        {showRecords && (
          <ol className="grid gap-1 py-1">
            {group.events.map((event) => {
              const record = records?.get(event.id);
              const technical = record ? maskedActivityRecord(record, group) : "";
              return (
                <li key={event.id}>
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleTimeString("ko-KR")}
                  </time>
                  {" · "}
                  {toolEventLabel[event.kind] ?? event.kind} <code>{event.kind}</code>
                  {" · "}
                  {toolPhaseLabel[event.phase]}
                  {event.exitCode !== undefined && ` · 종료 코드 ${event.exitCode}`}
                  {technical && <pre className="whitespace-pre-wrap break-all">{technical}</pre>}
                </li>
              );
            })}
          </ol>
        )}
      </details>
    </div>
  );
}
export function ToolActivityRow({
  group,
  hideExecutor = false,
}: {
  group: ThreadToolActivity;
  hideExecutor?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const durationLabel = formatDurationCompact(group.preview?.durationMs);
  const evidenceBadge =
    group.action === "edit" && group.evidence === "confirmed-diff"
      ? "Diff 확인"
      : group.action === "edit" && group.evidence === "tool-reported"
        ? "도구 보고"
        : null;
  return (
    <details className="min-w-0 text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        className="cursor-pointer truncate rounded py-1 focus-visible:outline-ring"
        title={group.summary}
      >
        {!hideExecutor && (
          <>
            <span
              className="inline-block max-w-[38%] truncate align-bottom text-muted-foreground"
              title={group.executorLabel}
            >
              {group.executorLabel}
            </span>
            {" · "}
          </>
        )}
        <span>{group.summary}</span>
        {durationLabel && (
          <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground">
            {durationLabel}
          </span>
        )}
        {evidenceBadge && (
          <span className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
            {evidenceBadge}
          </span>
        )}
      </summary>
      {open && <ActivityExplanation group={group} />}
    </details>
  );
}

export function UnlinkedToolRecords({ groups }: { groups: readonly ThreadToolActivity[] }) {
  const records = useContext(ActivityRecordContext);
  const [open, setOpen] = useState(false);
  return (
    <details
      className="min-w-0 text-xs text-muted-foreground"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer py-1">
        연결되지 않은 중간 기술 기록 {groups.reduce((sum, g) => sum + g.events.length, 0)}건
      </summary>
      {open && (
        <>
          <p>종료된 턴에서 호출 ID가 없어 결과와 연결할 수 없는 시작·진행 기록입니다.</p>
          <ol>
            {groups.flatMap((group) =>
              group.events.map((e) => {
                const event = records?.get(e.id);
                const detail = event && maskedActivityRecord(event, group);
                return (
                  <li key={e.id} className="py-1">
                    <time dateTime={e.createdAt}>
                      {new Date(e.createdAt).toLocaleTimeString("ko-KR")}
                    </time>
                    {" · "}
                    {group.summary}
                    {" · "}
                    <code>{e.kind}</code>
                    {detail && <pre className="whitespace-pre-wrap break-all">{detail}</pre>}
                  </li>
                );
              }),
            )}
          </ol>
        </>
      )}
    </details>
  );
}
