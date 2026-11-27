import {
  bgProviderDisplayName,
  rollupBackgroundTasks,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function BgTaskPeekPopover({
  tasks,
  onStopAll,
  stopping = false,
}: {
  readonly tasks: readonly UnifiedBgTask[];
  readonly onStopAll?: () => void;
  readonly stopping?: boolean;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const rollup = rollupBackgroundTasks(tasks);
  useEffect(() => {
    if (tasks.length === 0) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [tasks.length]);
  const visible =
    filter === "all"
      ? tasks
      : tasks.filter((task) => bgProviderDisplayName(task.provider).toLowerCase() === filter);

  if (tasks.length === 0) return null;

  return (
    <div data-bg-task-peek="" className="mt-3 space-y-2 border-t border-border/60 pt-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
              filter === "all"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setFilter("all")}
          >
            전체 ({rollup.totalActive})
          </button>
          {rollup.byProvider.map((item) => (
            <button
              key={item.provider}
              type="button"
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                filter === item.provider
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => setFilter(item.provider)}
            >
              {item.label} ({item.count})
            </button>
          ))}
        </div>
        {onStopAll ? (
          <Button type="button" size="xs" variant="outline" disabled={stopping} onClick={onStopAll}>
            {stopping ? "종료 중…" : "전체 강제종료"}
          </Button>
        ) : null}
      </div>
      <div className="max-h-56 space-y-1.5 overflow-y-auto">
        {visible.map((task) => {
          const stalled = task.state === "STALLED";
          const failed = task.state === "FAILED";
          const progressSec = Math.max(0, Math.floor((nowMs - task.lastProgressAtMs) / 1000));
          return (
            <div
              key={task.taskId}
              data-bg-task-state={task.state}
              className={`rounded-md border px-2.5 py-1.5 text-xs ${
                failed
                  ? "border-destructive/50 bg-destructive/10"
                  : stalled
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-border/60 bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  [{bgProviderDisplayName(task.provider)}] {task.title}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {formatElapsed(task.startedAtMs, nowMs)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{task.proofHandle}</span>
                {task.artifactCount !== undefined ? (
                  <span>산출물 {task.artifactCount}개</span>
                ) : null}
                <span>
                  {stalled ? `[STALLED] ${progressSec}초 무출력 지연` : `${progressSec}초 전 갱신`}
                </span>
                {task.watcherArmed ? (
                  <span className="text-emerald-600 dark:text-emerald-400">Hook 연결됨</span>
                ) : null}
              </div>
              {task.logTail ? (
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/90">
                  {task.logTail}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
