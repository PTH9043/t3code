import { useMemo, useState } from "react";
import type {
  ExecutionKind,
  ExecutionLedgerEntry,
  ExecutionLedgerSummary,
  ExecutionRunStatus,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SettingsSection } from "../../components/settings/settingsLayout";

const NUMBER_FORMAT = new Intl.NumberFormat();

const EXECUTION_KIND_LABELS: Record<ExecutionKind, string> = {
  orchestra: "오케스트라",
  meeting: "회의 모드",
  workflow_v2: "워크플로 v2",
  workspace_delegate: "하위 팀 위임",
  council: "다자간 위원회",
  workspace_helper: "하위 API",
  upgrade_room: "업그레이드 방",
  claude_subagent: "Claude 서브에이전트",
  codex_subagent: "Codex 서브에이전트",
};

const STATUS_LABELS: Record<ExecutionRunStatus, string> = {
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  interrupted_by_restart: "재시작 중단",
};

type LedgerFilter = "all" | "running" | "issues";

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatElapsed(entry: ExecutionLedgerEntry, nowMs: number): string {
  const end = entry.finishedAtMs ?? nowMs;
  const elapsedMs = Math.max(0, end - entry.startedAtMs);
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)} ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)} s`;
  const mins = Math.floor(elapsedMs / 60_000);
  const secs = Math.floor((elapsedMs % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

function statusBadgeClass(status: ExecutionRunStatus): string {
  switch (status) {
    case "running":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case "completed":
      return "bg-muted text-foreground/80";
    case "failed":
      return "bg-destructive/15 text-destructive";
    case "cancelled":
      return "bg-muted text-muted-foreground";
    case "interrupted_by_restart":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  }
}

export function ExecutionLedgerDiagnosticsCard({
  summary,
  isInitialLoading,
}: {
  readonly summary: ExecutionLedgerSummary | undefined;
  readonly isInitialLoading: boolean;
}) {
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const nowMs = Date.now();

  const totals = useMemo(() => {
    if (!summary) {
      return { total: 0, running: 0, completed: 0, issues: 0 };
    }
    let completed = 0;
    let issues = 0;
    for (const row of summary.byKind) {
      completed += row.completed;
      issues += row.failed + row.interruptedByRestart;
    }
    return {
      total: summary.totalRuns,
      running: summary.activeRuns,
      completed,
      issues,
    };
  }, [summary]);

  const filteredRuns = useMemo(() => {
    const runs = summary?.recentRuns ?? [];
    if (filter === "running") {
      return runs.filter((run) => run.status === "running");
    }
    if (filter === "issues") {
      return runs.filter(
        (run) =>
          run.status === "failed" ||
          run.status === "interrupted_by_restart" ||
          run.status === "cancelled",
      );
    }
    return runs;
  }, [summary, filter]);

  return (
    <SettingsSection id="execution-ledger" title="9종 협업 통합 실행 원장">
      <div className="relative grid grid-cols-2 sm:grid-cols-4">
        <span
          className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/60"
          aria-hidden
        />
        <span
          className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border/60 sm:hidden"
          aria-hidden
        />
        <span
          className="pointer-events-none absolute inset-y-0 left-1/4 hidden w-px bg-border/60 sm:block"
          aria-hidden
        />
        <span
          className="pointer-events-none absolute inset-y-0 left-3/4 hidden w-px bg-border/60 sm:block"
          aria-hidden
        />
        <div className="min-w-0 px-4 py-3 sm:px-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            누적 실행
          </div>
          <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground">
            {summary ? formatCount(totals.total) : "..."}
          </div>
        </div>
        <div className="min-w-0 px-4 py-3 sm:px-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            실행 중
          </div>
          <div
            className={cn(
              "mt-1 truncate font-mono text-lg font-semibold tabular-nums",
              totals.running > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
            )}
          >
            {summary ? formatCount(totals.running) : "..."}
          </div>
        </div>
        <div className="min-w-0 px-4 py-3 sm:px-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            완료
          </div>
          <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground">
            {summary ? formatCount(totals.completed) : "..."}
          </div>
        </div>
        <div className="min-w-0 px-4 py-3 sm:px-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            실패 · 재시작 중단
          </div>
          <div
            className={cn(
              "mt-1 truncate font-mono text-lg font-semibold tabular-nums",
              totals.issues > 0 ? "text-amber-600 dark:text-amber-400" : "text-foreground",
            )}
          >
            {summary ? formatCount(totals.issues) : "..."}
          </div>
        </div>
      </div>

      {summary ? (
        <div className="border-t border-border/60">
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[680px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">협업 유형</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">실행 중</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">완료</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">실패</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">취소</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">재시작 중단</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pr-5">합계</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {summary.byKind.map((row) => (
                  <tr key={row.executionKind} className="hover:bg-muted/15">
                    <td className="px-4 py-2.5 align-middle font-medium text-foreground sm:pl-5">
                      <span>{EXECUTION_KIND_LABELS[row.executionKind]}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">
                        {row.executionKind}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 font-mono tabular-nums",
                        row.running > 0
                          ? "font-semibold text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {formatCount(row.running)}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-foreground">
                      {formatCount(row.completed)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 font-mono tabular-nums",
                        row.failed > 0 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {formatCount(row.failed)}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-muted-foreground">
                      {formatCount(row.cancelled)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 font-mono tabular-nums",
                        row.interruptedByRestart > 0
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {formatCount(row.interruptedByRestart)}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums font-medium text-foreground sm:pr-5">
                      {formatCount(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </div>
      ) : null}

      <div className="border-t border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            최근 협업 실행 이력
          </span>
          <div className="inline-flex items-center gap-1">
            {(
              [
                ["all", "전체"],
                ["running", "실행 중"],
                ["issues", "실패 · 중단"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
                  filter === key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredRuns.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none border-t border-border/60"
          >
            <table className="w-full min-w-[780px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[13%]" />
                <col className="w-[37%]" />
                <col className="w-[18%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold sm:pl-5">유형</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold">상태</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold">요약 / 오류</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold">모델 · 제공자</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold sm:pr-5">소요 시간</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredRuns.map((run) => (
                  <tr key={run.executionId} className="hover:bg-muted/15">
                    <td className="truncate px-4 py-2.5 align-top font-medium text-foreground sm:pl-5">
                      {EXECUTION_KIND_LABELS[run.executionKind]}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span
                        className={cn(
                          "inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium",
                          statusBadgeClass(run.status),
                        )}
                      >
                        {STATUS_LABELS[run.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 align-top text-muted-foreground">
                      <div className="truncate text-foreground/90">{run.summary}</div>
                      {run.errorMessage ? (
                        <div className="mt-0.5 truncate text-[11px] text-destructive">
                          {run.errorMessage}
                        </div>
                      ) : null}
                    </td>
                    <td className="truncate px-4 py-2.5 align-top font-mono text-[11px] text-muted-foreground">
                      {run.model ?? run.provider ?? "-"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 align-top font-mono tabular-nums text-muted-foreground sm:pr-5">
                      {formatElapsed(run, nowMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
            {isInitialLoading
              ? "협업 실행 원장을 불러오는 중..."
              : filter === "all"
                ? "기록된 협업 실행 이력이 없습니다."
                : "선택한 상태에 해당하는 협업 실행 이력이 없습니다."}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
