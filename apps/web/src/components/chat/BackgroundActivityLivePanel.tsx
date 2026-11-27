import {
  bgProviderDisplayName,
  rollupBackgroundTasks,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface BackgroundActivityLivePanelProps {
  readonly tasks: readonly UnifiedBgTask[];
  readonly liveness: "working" | "monitoring" | null;
  readonly workingStepLabel?: string | null;
  readonly monitorTitles?: readonly string[];
  readonly latestActivityLabel?: string | null;
  readonly isWorking?: boolean;
  readonly onStopBackgroundWork?: () => void;
  readonly isStoppingBackgroundWork?: boolean;
  readonly defaultExpanded?: boolean;
  readonly nowMsOverride?: number;
}

/**
 * In-chat live status card rendered directly above the composer whenever
 * background tasks or monitors are running. Starts collapsed by default so
 * active background tasks do not intrude on the conversation view; the user
 * can expand details on demand.
 */
export function BackgroundActivityLivePanel({
  tasks,
  liveness,
  workingStepLabel = null,
  monitorTitles = [],
  latestActivityLabel = null,
  isWorking = false,
  onStopBackgroundWork,
  isStoppingBackgroundWork = false,
  defaultExpanded = false,
  nowMsOverride,
}: BackgroundActivityLivePanelProps) {
  const activeTasks = tasks.filter((task) => task.state !== "COMPLETED");
  const hasVisibleWork = activeTasks.length > 0 || liveness !== null || monitorTitles.length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [tickNowMs, setTickNowMs] = useState(() => nowMsOverride ?? Date.now());

  useEffect(() => {
    if (!hasVisibleWork || nowMsOverride !== undefined) return;
    setTickNowMs(Date.now());
    const timer = window.setInterval(() => {
      setTickNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [hasVisibleWork, nowMsOverride]);

  if (!hasVisibleWork) {
    return null;
  }

  const nowMs = nowMsOverride ?? tickNowMs;
  const rollup = rollupBackgroundTasks(activeTasks);
  const earliestStartMs =
    activeTasks.length > 0 ? Math.min(...activeTasks.map((task) => task.startedAtMs)) : null;

  const hasFailed = rollup.failedCount > 0;
  const hasStalled = rollup.stalledCount > 0;
  const toneClass = hasFailed
    ? "border-destructive/45 bg-destructive/8"
    : hasStalled
      ? "border-amber-500/45 bg-amber-500/8"
      : "border-emerald-500/35 bg-background/95";
  const dotClass = hasFailed ? "bg-destructive" : hasStalled ? "bg-amber-500" : "bg-emerald-500";

  const providerSummary = rollup.byProvider
    .map((entry) => `${entry.label} ${entry.count}`)
    .join(" · ");

  const headline =
    activeTasks.length > 0
      ? `AI 백그라운드 작업 진행 중 (${activeTasks.length}건${providerSummary ? ` · ${providerSummary}` : ""})`
      : liveness === "monitoring"
        ? "AI 백그라운드 감시 진행 중"
        : "AI 백그라운드 작업 진행 중";

  return (
    <section
      aria-label="현재 채팅방 백그라운드 작업 현황"
      data-bg-live-panel=""
      data-bg-live-state={hasFailed ? "failed" : hasStalled ? "stalled" : "running"}
      className={cn(
        "mx-auto mb-2 w-full rounded-xl border px-3 py-2 text-xs shadow-sm backdrop-blur-sm",
        toneClass,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dotClass)} />
          <span className="truncate font-medium text-foreground">{headline}</span>
          {earliestStartMs !== null ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatElapsed(earliestStartMs, nowMs)}
            </span>
          ) : null}
          {hasStalled ? (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              지연 {rollup.stalledCount}건
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onStopBackgroundWork ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={isStoppingBackgroundWork}
              onClick={onStopBackgroundWork}
            >
              {isStoppingBackgroundWork ? "중지 중…" : "중지"}
            </Button>
          ) : null}
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "백그라운드 작업 상세 접기" : "백그라운드 작업 상세 펼치기"}
            onClick={() => setExpanded((current) => !current)}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {expanded ? (
              <>
                접기 <ChevronUpIcon className="size-3.5" />
              </>
            ) : (
              <>
                상세 <ChevronDownIcon className="size-3.5" />
              </>
            )}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto border-t border-border/60 pt-2">
          {activeTasks.length > 0 ? (
            activeTasks.map((task) => {
              const stalled = task.state === "STALLED";
              const failed = task.state === "FAILED";
              const progressSec = Math.max(0, Math.floor((nowMs - task.lastProgressAtMs) / 1000));
              return (
                <div
                  key={task.taskId}
                  data-bg-live-task={task.taskId}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5",
                    failed
                      ? "border-destructive/45 bg-destructive/10"
                      : stalled
                        ? "border-amber-500/45 bg-amber-500/10"
                        : "border-border/60 bg-muted/35",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-foreground">
                      [{bgProviderDisplayName(task.provider)}] {task.title}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatElapsed(task.startedAtMs, nowMs)}
                    </span>
                  </div>
                  {task.logTail ? (
                    <p
                      data-bg-live-log-tail=""
                      className="mt-1 line-clamp-2 break-all font-mono text-[11px] text-foreground/85"
                    >
                      {task.logTail}
                    </p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="font-mono">{task.proofHandle}</span>
                    <span>
                      {stalled
                        ? `60초 이상 무출력 지연 (${progressSec}초 경과)`
                        : `${progressSec}초 전 갱신`}
                    </span>
                    {task.artifactCount !== undefined ? (
                      <span>산출물 {task.artifactCount}개</span>
                    ) : null}
                    {task.watcherArmed ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        완료 자동보고 연결됨
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="space-y-1 text-[11px] text-muted-foreground">
              {workingStepLabel ? (
                <p className="font-medium text-foreground">현재 단계: {workingStepLabel}</p>
              ) : null}
              {latestActivityLabel ? (
                <p className="truncate font-mono text-foreground/85">
                  최근 활동: {latestActivityLabel}
                </p>
              ) : null}
              {monitorTitles.length > 0 ? (
                <p className="truncate">감시 대상: {monitorTitles.join(" · ")}</p>
              ) : null}
              {!workingStepLabel && !latestActivityLabel && monitorTitles.length === 0 ? (
                <p>
                  백그라운드 런타임이 활성 상태입니다. 출력 이벤트가 도착하는 대로 여기에
                  표시됩니다.
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
