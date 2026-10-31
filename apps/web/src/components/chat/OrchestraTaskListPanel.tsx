import { memo, useId, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  orchestraKindLabels,
  orchestraTaskIsExpanded,
  orchestraTaskMatchesFilter,
  orchestraTaskStatusLabels,
  type OrchestraTaskAttemptView,
  type OrchestraTaskFilter,
  type OrchestraTaskList,
  type OrchestraTaskView,
} from "@t3tools/client-runtime/state/presentation";
import { cn } from "~/lib/utils";

export interface OrchestraListState {
  readonly filter: OrchestraTaskFilter;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly history: Readonly<Record<string, boolean>>;
}
export const DEFAULT_ORCHESTRA_LIST_STATE: OrchestraListState = {
  filter: "all",
  expanded: {},
  history: {},
};
const FILTERS = [
  ["all", "전체"],
  ["running", "실행 중"],
  ["attention", "확인 필요"],
  ["completed", "완료"],
] as const;
const ACTION_CLASS =
  "rounded-md px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const RUN_STATUS = {
  queued: "실행 대기",
  running: "진행 중",
  "cancel-requested": "중지 중 · 하위 AI 종료 대기",
  cancelled: "중지됨",
  completed: "완료",
  failed: "실패로 종료됨",
} as const;

/** Controlled disclosures live above the virtual list, so scrolling cannot reset a user's choice. */
export const OrchestraTaskListPanel = memo(function OrchestraTaskListPanel({
  list,
  state,
  onChange,
  renderAttempt,
  renderUsage,
  controls,
}: {
  readonly controls?: ReactNode;
  readonly list: OrchestraTaskList;
  readonly state: OrchestraListState;
  readonly onChange: (next: OrchestraListState) => void;
  readonly renderAttempt: (attempt: OrchestraTaskAttemptView) => ReactNode;
  readonly renderUsage?: (task: OrchestraTaskView) => ReactNode;
}) {
  const prefix = useId();
  const visible = list.tasks.filter((task) => orchestraTaskMatchesFilter(task, state.filter));
  const count = (filter: OrchestraTaskFilter) =>
    list.tasks.filter((task) => orchestraTaskMatchesFilter(task, filter)).length;
  const waiting = list.tasks.filter(
    (task) => task.status === "queued" || task.status === "blocked",
  ).length;
  const setAll = (expanded: boolean) =>
    onChange({
      ...state,
      expanded: Object.fromEntries(list.tasks.map((task) => [task.id, expanded])),
    });
  return (
    <section
      className="my-2 min-w-0 overflow-hidden rounded-xl border border-border bg-card"
      aria-labelledby={`${prefix}-title`}
      data-orchestra-run={list.id}
    >
      <div className="space-y-2 border-b border-border bg-muted/30 px-3 py-3 sm:px-4">
        <h3 id={`${prefix}-title`} className="text-sm font-semibold">
          오케스트라 작업 목록
        </h3>
        {list.status && (
          <p className="text-xs font-medium" role="status">
            {list.run?.graph?.planReview?.status === "pending"
              ? "계획 확인 대기"
              : list.run?.graph?.delivery && list.run.graph.delivery.status !== "passed"
                ? "결과 검증 · 통합 확인"
                : list.question && list.status === "running"
                  ? "답변 대기"
                  : RUN_STATUS[list.status]}
          </p>
        )}
        <p className="line-clamp-2 break-words text-xs text-muted-foreground" title={list.title}>
          {list.title}
        </p>
        {list.conductor && <p className="break-words text-xs">지휘: {list.conductor}</p>}
        {controls}
        {list.question && (
          <div
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            role="status"
          >
            <p className="whitespace-pre-wrap">{list.question}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              대화 입력창에서 답변하면 작업이 이어집니다.
            </p>
          </div>
        )}
        <p className="text-xs tabular-nums text-muted-foreground">
          전체 {list.tasks.length} · 완료 {count("completed")} · 실행/검증 {count("running")} · 대기{" "}
          {waiting} · 확인 필요 {count("attention")}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex flex-wrap gap-1" role="group" aria-label="작업 상태 필터">
            {FILTERS.map(([filter, label]) => (
              <button
                key={filter}
                type="button"
                aria-pressed={state.filter === filter}
                className={cn(
                  ACTION_CLASS,
                  state.filter === filter && "bg-accent font-medium text-accent-foreground",
                )}
                onClick={() => onChange({ ...state, filter })}
              >
                {label} {count(filter)}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-1">
            <button type="button" className={ACTION_CLASS} onClick={() => setAll(false)}>
              모두 접기
            </button>
            <button type="button" className={ACTION_CLASS} onClick={() => setAll(true)}>
              모두 펼치기
            </button>
          </div>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {list.tasks.length === 0
            ? list.status === "cancelled" || list.status === "failed" || list.status === "completed"
              ? "종료된 실행입니다."
              : "지휘 AI의 작업 배정을 기다리는 중입니다."
            : "이 상태의 작업이 없습니다."}
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {visible.map((task) => {
            const expanded = orchestraTaskIsExpanded(task, state.expanded[task.id]);
            const latest = task.attempts.at(-1);
            const previous = task.attempts.slice(0, -1);
            const retryCount = Math.max(0, (latest?.number ?? 1) - 1);
            const Icon = expanded ? ChevronDownIcon : ChevronRightIcon;
            return (
              <li key={task.id} data-orchestra-task={task.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`${prefix}-${task.id}`}
                  className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
                  onClick={() =>
                    onChange({ ...state, expanded: { ...state.expanded, [task.id]: !expanded } })
                  }
                >
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">
                      {orchestraKindLabels[task.kind]} · {task.title}
                    </span>
                    <span className="mt-1 block break-words text-xs text-muted-foreground">
                      {task.displayName}
                      {task.modelSelection ? ` · ${task.modelSelection.model}` : ""}
                      {retryCount > 0 ? ` · 재시도 ${retryCount}회` : ""}
                    </span>
                    {task.progress && (
                      <span
                        className="mt-1 block break-words text-xs text-muted-foreground"
                        data-orchestra-progress
                      >
                        최근 활동 · {task.progress.summary} ·{" "}
                        <time dateTime={task.progress.createdAt} title={task.progress.createdAt}>
                          {new Date(task.progress.createdAt).toLocaleTimeString("ko-KR", {
                            hour12: false,
                          })}
                        </time>
                      </span>
                    )}
                    {task.waitReason && (
                      <span className="mt-1 block break-words text-xs text-muted-foreground">
                        {task.waitReason}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      task.status === "failed" || task.status === "awaiting-user"
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {orchestraTaskStatusLabels[task.status]}
                  </span>
                </button>
                {expanded && (
                  <div
                    id={`${prefix}-${task.id}`}
                    className="min-w-0 space-y-3 border-t border-border/40 px-3 py-3 sm:px-4"
                  >
                    {task.completedAttemptMs != null && (
                      <p className="text-xs tabular-nums text-muted-foreground">
                        완료된 시도 실행 시간 ·{" "}
                        {(task.completedAttemptMs / 1000).toLocaleString("ko-KR", {
                          maximumFractionDigits: 1,
                        })}
                        초
                      </p>
                    )}
                    {renderUsage?.(task)}
                    {task.instruction && (
                      <details className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">작업 지시</summary>
                        <p className="mt-2 whitespace-pre-wrap">{task.instruction}</p>
                      </details>
                    )}
                    {task.question && (
                      <p className="whitespace-pre-wrap text-sm">답변 필요: {task.question}</p>
                    )}
                    {task.error && (
                      <p className="whitespace-pre-wrap text-xs text-destructive">{task.error}</p>
                    )}
                    {latest ? (
                      renderAttempt(latest)
                    ) : (
                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                        {task.output ??
                          (task.status === "completed"
                            ? "실행 계획에 기록된 단계입니다."
                            : "아직 실행 결과가 없습니다.")}
                      </p>
                    )}
                    {task.validation && (
                      <details className="rounded-md border border-border p-2 text-xs">
                        <summary className="cursor-pointer">
                          검증 근거 · {task.validation.verdict} · {task.validation.confidence}
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap">{task.validation.summary}</p>
                        <ul className="mt-2 list-disc space-y-1 pl-4">
                          {[...new Set(task.validation.evidence)].map((evidence) => (
                            <li key={evidence} className="whitespace-pre-wrap">
                              {evidence}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {previous.length > 0 && (
                      <div className="border-t border-border pt-2">
                        <button
                          type="button"
                          className={ACTION_CLASS}
                          aria-expanded={state.history[task.id] ?? false}
                          onClick={() =>
                            onChange({
                              ...state,
                              history: { ...state.history, [task.id]: !state.history[task.id] },
                            })
                          }
                        >
                          이전 시도 {previous.length}개 {state.history[task.id] ? "접기" : "보기"}
                        </button>
                        {state.history[task.id] && (
                          <ol className="mt-2 space-y-3">
                            {previous.map((attempt) => (
                              <li
                                key={attempt.key}
                                className="min-w-0 rounded-md border border-border p-3"
                              >
                                <p className="mb-2 break-words text-xs text-muted-foreground">
                                  시도 {attempt.number} · {attempt.displayName} ·{" "}
                                  {attempt.modelSelection?.model} ·{" "}
                                  {orchestraTaskStatusLabels[attempt.status]}
                                </p>
                                {attempt.instruction !== task.instruction &&
                                  attempt.instruction && (
                                    <p className="mb-2 whitespace-pre-wrap text-xs text-muted-foreground">
                                      {attempt.instruction}
                                    </p>
                                  )}
                                {renderAttempt(attempt)}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
