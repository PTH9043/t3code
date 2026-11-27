import type {
  EnvironmentId,
  ThreadId,
  WorkerDecisionGateRecord,
  WorkerDispatchRecord,
  WorkerMailboxMessageRecord,
  WorkerStatusResult,
  WorkerTaskRecord,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  FileDiffIcon,
  GitBranchIcon,
  InboxIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SquareIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";

import {
  ackWorkerDelivery,
  checkWorkerMailbox,
  getWorkerStatus,
  listWorkerGates,
  resolveWorkerGate,
  stopWorkerDispatch,
  type WorkerEngineRequestContext,
} from "./workerEngineClient";
import {
  buildMailboxAckPlan,
  computeWorkerEngineCounts,
  describeHeartbeatAge,
  formatWorkerDurationMs,
  isWorktreeReviewable,
  sortWorkerTasksForBoard,
  WORKER_CALLER_KIND_LABELS,
  WORKER_DISPATCH_STATUS_META,
  WORKER_GATE_RISK_META,
  WORKER_GATE_STATUS_META,
  WORKER_MAILBOX_TYPE_META,
  WORKER_TASK_STATUS_META,
  WORKER_WORKTREE_STATE_META,
} from "./workerEngineUi.logic";
import { WorkerDispatchDialog } from "./WorkerDispatchDialog";
import { WorkerWorktreeDiffDialog } from "./WorkerWorktreeDiffDialog";

export type WorkerEnginePanelTab = "tasks" | "mailbox" | "gates" | "worktrees";

export interface WorkerEnginePanelProps {
  readonly mode: "panel" | "diagnostics";
  readonly environmentId?: EnvironmentId | null;
  readonly threadId?: ThreadId | null;
  readonly defaultCwd?: string | null;
  /** Optional injection for deterministic unit tests. */
  readonly fetchFn?: typeof globalThis.fetch;
}

function formatClockTime(timestampMs: number): string {
  try {
    return new Date(timestampMs).toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function WorkerEnginePanel({
  mode,
  environmentId = null,
  threadId = null,
  defaultCwd = null,
  fetchFn,
}: WorkerEnginePanelProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [scope, setScope] = useState<"thread" | "all">(() => (threadId ? "thread" : "all"));
  const [activeTab, setActiveTab] = useState<WorkerEnginePanelTab>("tasks");
  const [gateFilter, setGateFilter] = useState<"open" | "all">("open");

  const [status, setStatus] = useState<WorkerStatusResult | null>(null);
  const [mailboxMessages, setMailboxMessages] = useState<ReadonlyArray<WorkerMailboxMessageRecord>>(
    [],
  );
  const [allGates, setAllGates] = useState<ReadonlyArray<WorkerDecisionGateRecord>>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [gateNotes, setGateNotes] = useState<Record<string, string>>({});
  const [diffTargetTask, setDiffTargetTask] = useState<WorkerTaskRecord | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState<boolean>(false);

  const effectiveThreadId = scope === "thread" && threadId ? threadId : undefined;

  useEffect(() => {
    if (!threadId && scope === "thread") {
      setScope("all");
    }
  }, [scope, threadId]);

  const requestContext = useMemo<WorkerEngineRequestContext>(
    () => ({
      environmentId,
      primaryEnvironmentId,
      ...(fetchFn ? { fetchFn } : {}),
    }),
    [environmentId, fetchFn, primaryEnvironmentId],
  );

  const setItemBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const refreshAll = useCallback(
    async (options?: { readonly silent?: boolean }) => {
      if (!options?.silent) {
        setRefreshing(true);
      }
      try {
        const [nextStatus, nextMailbox, nextGates] = await Promise.all([
          getWorkerStatus(effectiveThreadId ? { threadId: effectiveThreadId } : {}, requestContext),
          checkWorkerMailbox(
            {
              ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
              peek: true,
              limit: 50,
            },
            requestContext,
          ),
          listWorkerGates(effectiveThreadId ? { threadId: effectiveThreadId } : {}, requestContext),
        ]);
        setStatus(nextStatus);
        setMailboxMessages(nextMailbox.messages);
        setAllGates(nextGates);
        setError(null);
        setNowMs(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [effectiveThreadId, requestContext],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const counts = useMemo(() => computeWorkerEngineCounts(status), [status]);

  // Adaptive polling: 5s while workers are active, 15s when idle; pauses when tab is hidden.
  useEffect(() => {
    const intervalMs = counts.activeCount > 0 ? 5_000 : 15_000;
    const pollTimer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshAll({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(pollTimer);
  }, [counts.activeCount, refreshAll]);

  // Lightweight 1s heartbeat ticker only while at least one dispatch is active.
  useEffect(() => {
    if (counts.activeCount === 0) return;
    const tickTimer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(tickTimer);
  }, [counts.activeCount]);

  const activeDispatchByTaskId = useMemo(() => {
    const map = new Map<string, WorkerDispatchRecord>();
    for (const dispatch of status?.activeDispatches ?? []) {
      map.set(dispatch.taskId, dispatch);
    }
    return map;
  }, [status?.activeDispatches]);

  const sortedTasks = useMemo(
    () => sortWorkerTasksForBoard(status?.tasks ?? [], status?.activeDispatches ?? []),
    [status?.activeDispatches, status?.tasks],
  );

  const worktreeTasks = useMemo(
    () =>
      sortedTasks.filter(
        (task) =>
          task.worktreeMode === "isolated" ||
          task.worktreePath !== null ||
          task.worktreeState !== "none",
      ),
    [sortedTasks],
  );

  const displayedGates = useMemo(
    () => (gateFilter === "open" ? allGates.filter((gate) => gate.status === "open") : allGates),
    [allGates, gateFilter],
  );

  const handleStopDispatch = useCallback(
    async (dispatch: WorkerDispatchRecord) => {
      setItemBusy(dispatch.dispatchId, true);
      try {
        await stopWorkerDispatch(
          {
            dispatchId: dispatch.dispatchId,
            reason: "사용자가 작업자 엔진 UI에서 중지함",
          },
          requestContext,
        );
        toastManager.add({
          type: "info",
          title: "작업자 실행을 중지했습니다",
          description: `${dispatch.role} (${dispatch.dispatchId.slice(0, 12)})`,
        });
        await refreshAll({ silent: true });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "작업자 중지에 실패했습니다",
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setItemBusy(dispatch.dispatchId, false);
      }
    },
    [refreshAll, requestContext, setItemBusy],
  );

  const handleResolveGate = useCallback(
    async (gate: WorkerDecisionGateRecord, decision: "approve" | "deny") => {
      setItemBusy(gate.gateId, true);
      try {
        const note = gateNotes[gate.gateId]?.trim();
        await resolveWorkerGate(
          {
            gateId: gate.gateId,
            decision,
            ...(note ? { resolution: note } : {}),
            resolvedBy: "user:ui",
          },
          requestContext,
        );
        toastManager.add({
          type: decision === "approve" ? "success" : "info",
          title:
            decision === "approve" ? "승인 게이트를 승인했습니다" : "승인 게이트를 거절했습니다",
          description: gate.question.slice(0, 80),
        });
        setGateNotes((prev) => {
          const next = { ...prev };
          delete next[gate.gateId];
          return next;
        });
        await refreshAll({ silent: true });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "승인 게이트 처리 실패",
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setItemBusy(gate.gateId, false);
      }
    },
    [gateNotes, refreshAll, requestContext, setItemBusy],
  );

  const handleAckDelivery = useCallback(
    async (deliveryId: string) => {
      setItemBusy(deliveryId, true);
      try {
        const res = await ackWorkerDelivery({ deliveryId }, requestContext);
        toastManager.add({
          type: "success",
          title: `메일 ${res.acknowledgedMessageCount}건을 확인(ACK)했습니다`,
        });
        await refreshAll({ silent: true });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "메일 확인(ACK) 실패",
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setItemBusy(deliveryId, false);
      }
    },
    [refreshAll, requestContext, setItemBusy],
  );

  const handleAckAllUnread = useCallback(async () => {
    const plan = buildMailboxAckPlan(mailboxMessages);
    if (plan.existingDeliveryIds.length === 0 && !plan.hasUnclaimedMessages) {
      return;
    }
    setItemBusy("__ack_all__", true);
    try {
      let ackedTotal = 0;
      for (const deliveryId of plan.existingDeliveryIds) {
        const res = await ackWorkerDelivery({ deliveryId }, requestContext);
        ackedTotal += res.acknowledgedMessageCount;
      }
      if (plan.hasUnclaimedMessages) {
        const claimed = await checkWorkerMailbox(
          {
            ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
            peek: false,
            wait: false,
            limit: 100,
          },
          requestContext,
        );
        if (claimed.deliveryId) {
          const res = await ackWorkerDelivery({ deliveryId: claimed.deliveryId }, requestContext);
          ackedTotal += res.acknowledgedMessageCount;
        }
      }
      toastManager.add({
        type: "success",
        title: `미확인 메일 ${ackedTotal}건을 읽음 처리했습니다`,
      });
      await refreshAll({ silent: true });
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "미확인 메일 일괄 확인 실패",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setItemBusy("__ack_all__", false);
    }
  }, [effectiveThreadId, mailboxMessages, refreshAll, requestContext, setItemBusy]);

  const bodyContent = (
    <div className="flex flex-col gap-3 p-3">
      {/* Header controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <WorkflowIcon aria-hidden className="size-4 text-primary" />
          <h3 className="text-xs font-semibold text-foreground">작업자 엔진</h3>
          <span className="font-mono text-[11px] text-muted-foreground">
            {effectiveThreadId ? "현재 방" : "전체"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {threadId ? (
            <div
              role="group"
              aria-label="조회 범위"
              className="inline-flex rounded-md border border-border/60 bg-muted/30 p-0.5 text-[11px]"
            >
              <button
                type="button"
                onClick={() => setScope("thread")}
                className={cn(
                  "rounded-sm px-2 py-0.5 transition-colors",
                  scope === "thread"
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                현재 방
              </button>
              <button
                type="button"
                onClick={() => setScope("all")}
                className={cn(
                  "rounded-sm px-2 py-0.5 transition-colors",
                  scope === "all"
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                전체
              </button>
            </div>
          ) : null}

          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={refreshing}
            aria-label="작업자 상태 새로고침"
            onClick={() => void refreshAll()}
          >
            <RefreshCwIcon aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
          </Button>

          <Button type="button" size="xs" variant="outline" onClick={() => setDispatchOpen(true)}>
            <PlusIcon aria-hidden className="size-3.5" />
            작업자 파견
          </Button>
        </div>
      </div>

      {/* Summary KPI strip */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => setActiveTab("tasks")}
          className={cn(
            "rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-accent/40",
            activeTab === "tasks" && "border-primary/40 bg-accent/30",
          )}
        >
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            실행 중
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-sm font-semibold tabular-nums text-foreground">
            <span>{counts.activeCount}</span>
            {counts.stalledCount > 0 ? (
              <span className="text-[10px] font-normal text-warning-foreground">
                멈춤 {counts.stalledCount}
              </span>
            ) : null}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("gates")}
          className={cn(
            "rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-accent/40",
            activeTab === "gates" && "border-primary/40 bg-accent/30",
          )}
        >
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            승인 대기
          </div>
          <div
            className={cn(
              "mt-0.5 font-mono text-sm font-semibold tabular-nums",
              counts.openGateCount > 0 ? "text-warning-foreground" : "text-foreground",
            )}
          >
            {counts.openGateCount}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("worktrees")}
          className={cn(
            "rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-accent/40",
            activeTab === "worktrees" && "border-primary/40 bg-accent/30",
          )}
        >
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Worktree 검토
          </div>
          <div
            className={cn(
              "mt-0.5 font-mono text-sm font-semibold tabular-nums",
              counts.reviewReadyCount > 0 ? "text-warning-foreground" : "text-foreground",
            )}
          >
            {counts.reviewReadyCount}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("mailbox")}
          className={cn(
            "rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-accent/40",
            activeTab === "mailbox" && "border-primary/40 bg-accent/30",
          )}
        >
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            미확인 메일
          </div>
          <div
            className={cn(
              "mt-0.5 font-mono text-sm font-semibold tabular-nums",
              counts.unreadMailboxCount > 0 ? "text-info-foreground" : "text-foreground",
            )}
          >
            {counts.unreadMailboxCount}
          </div>
        </button>
      </div>

      {/* Sub-navigation tabs */}
      <div
        role="tablist"
        aria-label="작업자 엔진 섹션"
        className="flex flex-wrap items-center gap-1 border-b border-border/60 pb-2"
      >
        {(
          [
            { id: "tasks", label: "작업자", count: sortedTasks.length },
            { id: "mailbox", label: "메일박스", count: counts.unreadMailboxCount },
            { id: "gates", label: "승인 게이트", count: counts.openGateCount },
            { id: "worktrees", label: "Worktree", count: worktreeTasks.length },
          ] as const
        ).map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                selected
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span>{tab.label}</span>
              <span className="rounded-sm bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive-foreground">
          <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</div>
          <Button type="button" size="xs" variant="outline" onClick={() => void refreshAll()}>
            재시도
          </Button>
        </div>
      ) : null}

      {loading && !status ? (
        <div className="rounded-md border border-border/60 bg-muted/20 p-4 text-xs text-muted-foreground">
          작업자 엔진 상태를 불러오는 중...
        </div>
      ) : null}

      {/* Tab 1: Workers / Tasks */}
      {!loading && activeTab === "tasks" ? (
        sortedTasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-5 text-center">
            <p className="text-xs font-medium text-foreground">기록된 작업자가 없습니다</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              하위 위임·위원회·오케스트라·CLI 작업이 실행되거나 위에서 직접 작업자를 파견하면 여기에
              실시간 상태가 표시됩니다.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sortedTasks.map((task) => {
              const activeDispatch = activeDispatchByTaskId.get(task.taskId) ?? null;
              const taskMeta = WORKER_TASK_STATUS_META[task.status];
              const dispatchMeta = activeDispatch
                ? WORKER_DISPATCH_STATUS_META[activeDispatch.status]
                : null;
              const worktreeMeta = WORKER_WORKTREE_STATE_META[task.worktreeState];
              const heartbeat = activeDispatch
                ? describeHeartbeatAge(activeDispatch.lastHeartbeatAtMs, nowMs)
                : null;
              const stopping = activeDispatch ? busyIds.has(activeDispatch.dispatchId) : false;

              return (
                <article
                  key={task.taskId}
                  className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        (dispatchMeta ?? taskMeta).dotClass,
                      )}
                    />
                    <span className="font-semibold text-foreground">{task.role}</span>
                    <Badge size="sm" variant={(dispatchMeta ?? taskMeta).variant}>
                      {(dispatchMeta ?? taskMeta).label}
                    </Badge>
                    <Badge size="sm" variant="outline" className="font-mono">
                      {task.targetInstanceId}
                      {task.targetModel ? `:${task.targetModel}` : ""}
                    </Badge>
                    <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {WORKER_CALLER_KIND_LABELS[task.callerKind]}
                    </span>
                    {task.failureCount > 0 ? (
                      <Badge size="sm" variant="error">
                        실패 {task.failureCount}회
                      </Badge>
                    ) : null}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {task.taskId.slice(0, 12)}
                    </span>
                  </div>

                  <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-foreground/90">
                    {task.specText}
                  </p>

                  {/* Live heartbeat / tool activity */}
                  {activeDispatch ? (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-muted/30 px-2 py-1 font-mono text-[11px]">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1",
                          heartbeat?.severity === "danger"
                            ? "text-destructive-foreground"
                            : heartbeat?.severity === "warning"
                              ? "text-warning-foreground"
                              : "text-muted-foreground",
                        )}
                      >
                        <ClockIcon aria-hidden className="size-3" />
                        {heartbeat?.label}
                      </span>
                      <span className="text-muted-foreground">
                        경과 {formatWorkerDurationMs(nowMs - activeDispatch.startedAtMs)}
                      </span>
                      {activeDispatch.lastToolSummary ? (
                        <span className="truncate text-foreground/80">
                          ▸ {activeDispatch.lastToolSummary}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Worktree metadata */}
                  {task.worktreeBranch || task.worktreeState !== "none" ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                      <span className="font-mono truncate">
                        {task.worktreeBranch ?? "격리 Worktree"}
                      </span>
                      <Badge size="sm" variant={worktreeMeta.variant}>
                        {worktreeMeta.label}
                      </Badge>
                      {task.outcome?.filesModified.length ? (
                        <span className="font-mono">
                          파일 {task.outcome.filesModified.length}개
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Outcome summary collapsible */}
                  {task.outcome?.summary ? (
                    <details className="mt-2 text-[11px] text-muted-foreground">
                      <summary className="cursor-pointer font-medium hover:text-foreground">
                        실행 결과 요약 ({formatWorkerDurationMs(task.outcome.latencyMs)})
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap break-words rounded-sm bg-muted/30 p-2 text-foreground/90">
                        {task.outcome.summary}
                      </p>
                    </details>
                  ) : null}

                  {/* Action row */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {activeDispatch ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="destructive-outline"
                        disabled={stopping}
                        onClick={() => void handleStopDispatch(activeDispatch)}
                      >
                        <SquareIcon aria-hidden className="size-3" />
                        {stopping ? "중지 중..." : "중지"}
                      </Button>
                    ) : null}

                    {task.status === "blocked" ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setGateFilter("open");
                          setActiveTab("gates");
                        }}
                      >
                        <ShieldAlertIcon aria-hidden className="size-3" />
                        승인 게이트 확인
                      </Button>
                    ) : null}

                    {isWorktreeReviewable(task) ? (
                      <Button
                        type="button"
                        size="xs"
                        variant={task.worktreeState === "review_ready" ? "default" : "outline"}
                        onClick={() => setDiffTargetTask(task)}
                      >
                        <FileDiffIcon aria-hidden className="size-3" />
                        Diff 검토 · 병합/폐기
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      {/* Tab 2: Mailbox */}
      {!loading && activeTab === "mailbox" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              미확인 FIFO 메일 ({mailboxMessages.length}건)
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={mailboxMessages.length === 0 || busyIds.has("__ack_all__")}
              onClick={() => void handleAckAllUnread()}
            >
              <CheckCheckIcon aria-hidden className="size-3.5" />
              {busyIds.has("__ack_all__") ? "확인 처리 중..." : "모두 읽음 확인 (ACK)"}
            </Button>
          </div>

          {mailboxMessages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-5 text-center">
              <InboxIcon aria-hidden className="mx-auto mb-1.5 size-4 text-muted-foreground" />
              <p className="text-xs font-medium text-foreground">미확인 메일이 없습니다</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                작업 완료, 병합 준비(`merge_ready`), 멈춤 경고(`escalation`), 승인 요청이 도착하면
                FIFO 순서로 표시됩니다.
              </p>
            </div>
          ) : (
            mailboxMessages.map((msg) => {
              const meta = WORKER_MAILBOX_TYPE_META[msg.type];
              const acking = msg.deliveryId ? busyIds.has(msg.deliveryId) : false;
              return (
                <article
                  key={msg.messageId}
                  className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      #{msg.sequence}
                    </span>
                    <Badge size="sm" variant={meta.variant}>
                      {meta.label}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {msg.fromActor} → {msg.toActor}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {formatClockTime(msg.createdAtMs)}
                    </span>
                  </div>
                  <div className="mt-1 font-medium text-foreground">{msg.subject}</div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                    {msg.body}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {msg.taskId ? (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        task: {msg.taskId.slice(0, 12)}
                      </span>
                    ) : null}
                    {msg.deliveryId ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={acking}
                        onClick={() => void handleAckDelivery(msg.deliveryId!)}
                      >
                        <CheckIcon aria-hidden className="size-3" />
                        {acking ? "처리 중..." : "배달 확인 (ACK)"}
                      </Button>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        미배달 · 상단 모두 읽음 확인으로 수령/ACK 가능
                      </span>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      ) : null}

      {/* Tab 3: Decision Gates */}
      {!loading && activeTab === "gates" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex rounded-md border border-border/60 bg-muted/30 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setGateFilter("open")}
                className={cn(
                  "rounded-sm px-2 py-0.5 transition-colors",
                  gateFilter === "open"
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                승인 대기 ({counts.openGateCount})
              </button>
              <button
                type="button"
                onClick={() => setGateFilter("all")}
                className={cn(
                  "rounded-sm px-2 py-0.5 transition-colors",
                  gateFilter === "all"
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                전체 이력 ({allGates.length})
              </button>
            </div>
            <span className="text-[10px] text-muted-foreground">
              결정 내용은 감사 해시체인에 기록됩니다
            </span>
          </div>

          {displayedGates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-5 text-center">
              <ShieldAlertIcon
                aria-hidden
                className="mx-auto mb-1.5 size-4 text-muted-foreground"
              />
              <p className="text-xs font-medium text-foreground">
                {gateFilter === "open"
                  ? "대기 중인 승인 게이트가 없습니다"
                  : "기록된 승인 게이트가 없습니다"}
              </p>
            </div>
          ) : (
            displayedGates.map((gate) => {
              const riskMeta = WORKER_GATE_RISK_META[gate.riskLevel];
              const statusMeta = WORKER_GATE_STATUS_META[gate.status];
              const resolving = busyIds.has(gate.gateId);

              return (
                <article
                  key={gate.gateId}
                  className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge size="sm" variant={riskMeta.variant}>
                      위험도: {riskMeta.label}
                    </Badge>
                    <Badge size="sm" variant={statusMeta.variant}>
                      {statusMeta.label}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      task: {gate.taskId.slice(0, 12)}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {formatClockTime(gate.createdAtMs)}
                    </span>
                  </div>

                  <p className="mt-1.5 whitespace-pre-wrap break-words font-medium text-foreground">
                    {gate.question}
                  </p>

                  {gate.status === "open" ? (
                    <div className="mt-2 space-y-2">
                      {gate.options.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {gate.options.map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() =>
                                setGateNotes((prev) => ({ ...prev, [gate.gateId]: opt }))
                              }
                              className="rounded-sm border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <input
                        type="text"
                        aria-label={`게이트 ${gate.gateId} 결정 사유`}
                        value={gateNotes[gate.gateId] ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setGateNotes((prev) => ({ ...prev, [gate.gateId]: value }));
                        }}
                        placeholder="승인 또는 거절 사유 (선택)"
                        className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                      />

                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          disabled={resolving}
                          onClick={() => void handleResolveGate(gate, "approve")}
                        >
                          <CheckIcon aria-hidden className="size-3" />
                          승인
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive-outline"
                          disabled={resolving}
                          onClick={() => void handleResolveGate(gate, "deny")}
                        >
                          <XIcon aria-hidden className="size-3" />
                          거절
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 rounded-sm bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
                      {gate.resolution ? <div>사유: {gate.resolution}</div> : null}
                      <div>
                        처리자: {gate.resolvedBy ?? "시스템"}
                        {gate.resolvedAtMs ? ` · ${formatClockTime(gate.resolvedAtMs)}` : ""}
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      ) : null}

      {/* Tab 4: Isolated Worktrees */}
      {!loading && activeTab === "worktrees" ? (
        worktreeTasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-5 text-center">
            <GitBranchIcon aria-hidden className="mx-auto mb-1.5 size-4 text-muted-foreground" />
            <p className="text-xs font-medium text-foreground">격리 Worktree가 없습니다</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              격리 모드로 파견된 작업자가 완료되면 브랜치가 자동 보존되어 여기서 Diff 검토 후
              병합하거나 폐기할 수 있습니다.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {worktreeTasks.map((task) => {
              const wtMeta = WORKER_WORKTREE_STATE_META[task.worktreeState];
              const reviewable = isWorktreeReviewable(task);
              return (
                <article
                  key={task.taskId}
                  className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <GitBranchIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="font-mono font-medium text-foreground">
                      {task.worktreeBranch ?? task.taskId.slice(0, 12)}
                    </span>
                    <Badge size="sm" variant={wtMeta.variant}>
                      {wtMeta.label}
                    </Badge>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {task.role} · {task.targetInstanceId}
                    </span>
                  </div>
                  {task.worktreePath ? (
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {task.worktreePath}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {task.worktreeBaseRef ? `기준: ${task.worktreeBaseRef}` : ""}
                      {task.outcome?.filesModified.length
                        ? ` · 변경 파일 ${task.outcome.filesModified.length}개`
                        : ""}
                    </span>
                    {reviewable ? (
                      <Button
                        type="button"
                        size="xs"
                        variant={task.worktreeState === "review_ready" ? "default" : "outline"}
                        onClick={() => setDiffTargetTask(task)}
                      >
                        <FileDiffIcon aria-hidden className="size-3" />
                        Diff 검토 · 병합/폐기
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );

  return (
    <>
      {mode === "panel" ? (
        <div className="flex h-full min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">{bodyContent}</ScrollArea>
        </div>
      ) : (
        <div className="min-w-0">{bodyContent}</div>
      )}

      <WorkerWorktreeDiffDialog
        task={diffTargetTask}
        open={diffTargetTask !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDiffTargetTask(null);
          }
        }}
        requestContext={requestContext}
        onMutated={() => void refreshAll({ silent: true })}
      />

      <WorkerDispatchDialog
        open={dispatchOpen}
        onOpenChange={setDispatchOpen}
        threadId={threadId}
        defaultCwd={defaultCwd}
        requestContext={requestContext}
        onDispatched={() => void refreshAll({ silent: true })}
      />
    </>
  );
}
