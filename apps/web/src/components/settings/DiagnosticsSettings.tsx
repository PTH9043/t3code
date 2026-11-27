import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderOpenIcon,
  InfoIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessResourceHistorySummary,
  ServerProcessSignal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { cn } from "../../lib/utils";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { formatRelativeTimeLabel, getRelativeTimeState } from "../../timestampFormat";
import { useEnvironmentQuery } from "../../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerObservabilityAtom,
  serverEnvironment,
} from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { usePrimaryEnvironment } from "../../state/environments";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ResourceTelemetryDiagnostics } from "./ResourceTelemetryDiagnostics";
import { ExecutionLedgerDiagnosticsCard } from "../../t3x/diagnostics/ExecutionLedgerDiagnosticsCard";
import { WorkerEnginePanel } from "../../t3x/workerEngine/WorkerEnginePanel";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { useAtomCommand } from "../../state/use-atom-command";

const NUMBER_FORMAT = new Intl.NumberFormat();

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRelative(value: DateTime.Utc | null): string {
  if (!value) return "추적 기록 없음";
  return formatRelativeTimeLabel(DateTime.formatIso(value));
}

function formatRelativeNoWrap(value: DateTime.Utc | null): string {
  return formatRelative(value).replaceAll(" ", "\u00a0");
}

function shortenTraceId(traceId: string): string {
  if (traceId.length <= 32) return traceId;
  return `${traceId.slice(0, 18)}...${traceId.slice(-10)}`;
}

function isStaleProcessSignalMessage(message: string | undefined): boolean {
  return message?.includes("not a live descendant") ?? false;
}

function StatBlock({
  label,
  value,
  tooltip,
  tone = "default",
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 border-border/60 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span className="min-w-0 truncate">{label}</span>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground"
                  aria-label={`${label} 세부 정보`}
                >
                  <InfoIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup
              side="top"
              className="max-w-[min(300px,calc(100vw-2rem))] whitespace-normal text-left text-[11px] leading-relaxed text-wrap"
            >
              {tooltip}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatsGrid({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{label}</div>;
}

function ExpandableText({
  text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "오류 전체 보기",
}: {
  text: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 180 || text.includes("\n");

  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn(
          "whitespace-pre-wrap break-words",
          !expanded && canExpand ? collapsedClassName : null,
        )}
      >
        {text}
      </div>
      {canExpand ? (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : expandLabel}
        </button>
      ) : null}
    </div>
  );
}

function DiagnosticsTable({
  headers,
  children,
  minTableWidth = "min-w-[640px]",
  columnWidths,
}: {
  headers: ReadonlyArray<string>;
  children: ReactNode;
  minTableWidth?: string;
  columnWidths?: ReadonlyArray<string>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full rounded-none"
    >
      <table
        className={cn("w-full text-left text-xs", minTableWidth, columnWidths && "table-fixed")}
      >
        {columnWidths ? (
          <colgroup>
            {headers.map((header, index) => (
              <col key={header} className={columnWidths[index]} />
            ))}
          </colgroup>
        ) : null}
        <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
          <tr>
            {headers.map((header, index) => (
              <th
                key={header}
                className={cn(
                  "whitespace-nowrap px-4 py-2.5 font-semibold first:sm:pl-5 last:sm:pr-5",
                  !columnWidths && index === headers.length - 1 && "w-px",
                )}
              >
                {header.replaceAll(" ", "\u00a0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </ScrollArea>
  );
}

function TraceIdCell({ traceId }: { traceId: string }) {
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    target: "추적 ID",
    timeout: 1_200,
  });

  return (
    <div className="flex w-full min-w-0 max-w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {shortenTraceId(traceId)}
            </span>
          }
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(520px,calc(100vw-2rem))] break-all font-mono text-[11px]"
        >
          {traceId}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={copied ? "추적 ID 복사됨" : "추적 ID 복사"}
              onClick={() => copyToClipboard(traceId)}
            >
              <CopyIcon className="size-3" />
            </button>
          }
        />
        <TooltipPopup side="top">{copied ? "복사됨" : "전체 추적 ID 복사"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function formatProcessName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function formatProcessType(process: ServerProcessDiagnosticsEntry): string {
  if (process.depth > 0) return "하위 프로세스";
  if (/\b(codex|claude|opencode|cursor)\b/i.test(process.command)) return "에이전트";
  return "프로세스";
}

function ProcessNameCell({
  process,
  isExpanded,
  onToggle,
}: {
  process: ServerProcessDiagnosticsEntry;
  isExpanded: boolean;
  onToggle: (pid: number) => void;
}) {
  const name = formatProcessName(process.command);
  const hasChildren = process.childPids.length > 0;
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 6) * 10}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={isExpanded ? `${name} 접기` : `${name} 펼치기`}
          onClick={() => onToggle(process.pid)}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/80" />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
        >
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessSignalActions({
  process,
  isSignaling,
  onSignal,
}: {
  process: ServerProcessDiagnosticsEntry;
  isSignaling: boolean;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, "SIGINT")}
            >
              INT
            </button>
          }
        />
        <TooltipPopup side="top">SIGINT 보내기</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="text-[11px] font-medium text-destructive underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, "SIGKILL")}
            >
              KILL
            </button>
          }
        />
        <TooltipPopup side="top">SIGKILL 보내기</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessDiagnosticsTable({
  processes,
  signalingPid,
  onSignal,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>;
  signalingPid: number | null;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
  emptyLabel?: string;
}) {
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set());
  const visibleProcesses = useMemo(() => {
    const visible: ServerProcessDiagnosticsEntry[] = [];
    let hiddenChildDepth: number | null = null;

    for (const process of processes) {
      if (hiddenChildDepth !== null) {
        if (process.depth > hiddenChildDepth) continue;
        hiddenChildDepth = null;
      }

      visible.push(process);
      if (collapsedPids.has(process.pid)) {
        hiddenChildDepth = process.depth;
      }
    }

    return visible;
  }, [collapsedPids, processes]);

  const toggleProcess = useCallback((pid: number) => {
    setCollapsedPids((previous) => {
      const next = new Set(previous);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(64vh,44rem)] w-full max-w-full rounded-none border-t border-border/60"
    >
      <table className="w-full min-w-[1040px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[8%]" />
          <col className="w-[10%]" />
          <col className="w-[33%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
          <col className="w-[6%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">이름</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">메모리</th>
            <th className="px-3 py-2 font-semibold">명령</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-3 py-2 font-semibold">유형</th>
            <th className="p-2 text-right font-semibold sm:pr-4">종료</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                {emptyLabel ?? "실행 중인 하위 프로세스가 없습니다."}
              </td>
            </tr>
          ) : null}
          {visibleProcesses.map((process) => (
            <tr key={process.pid} className="hover:bg-muted/20">
              <td className="px-4 py-2 align-middle sm:pl-5">
                <ProcessNameCell
                  process={process}
                  isExpanded={!collapsedPids.has(process.pid)}
                  onToggle={toggleProcess}
                />
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.rssBytes)}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.command}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                {process.pid}
              </td>
              <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                {formatProcessType(process)}
              </td>
              <td className="p-2 align-middle sm:pr-4">
                <ProcessSignalActions
                  process={process}
                  isSignaling={signalingPid === process.pid}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

const RESOURCE_HISTORY_WINDOWS = [
  { label: "5분", windowMs: 5 * 60_000, bucketMs: 30_000 },
  { label: "15분", windowMs: 15 * 60_000, bucketMs: 60_000 },
  { label: "30분", windowMs: 30 * 60_000, bucketMs: 2 * 60_000 },
  { label: "1시간", windowMs: 60 * 60_000, bucketMs: 5 * 60_000 },
] as const;

function formatCpuTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}초`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}분`;
  return `${(minutes / 60).toFixed(2)}시간`;
}

function formatShortProcessName(command: string): string {
  const name = formatProcessName(command);
  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

function ResourceHistoryProcessNameCell({
  process,
  visualDepth,
}: {
  process: ServerProcessResourceHistorySummary;
  visualDepth: number;
}) {
  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }}
      aria-label={`${process.isServerRoot ? "루트" : "하위"} 프로세스 ${name}`}
    >
      <span className="size-5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.isServerRoot ? "bg-amber-500/90" : "bg-emerald-500/80",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
        >
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<{
    readonly startedAt: DateTime.Utc;
    readonly avgCpuPercent: number;
    readonly maxCpuPercent: number;
  }>;
}) {
  const maxCpuPercent = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex h-28 items-end gap-1 overflow-hidden rounded-sm bg-muted/10 p-2">
        {buckets.map((bucket) => {
          const peakHeight = Math.max(2, (bucket.maxCpuPercent / maxCpuPercent) * 100);
          const averageHeight = Math.max(2, (bucket.avgCpuPercent / maxCpuPercent) * 100);
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-1 flex-1 items-end">
                    <div
                      className="relative h-full w-full"
                      aria-label={`평균 CPU ${bucket.avgCpuPercent.toFixed(1)}%, 최대 CPU ${bucket.maxCpuPercent.toFixed(1)}%`}
                    >
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/15 transition-colors"
                        style={{ height: `${peakHeight}%` }}
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/60 transition-colors"
                        style={{ height: `${averageHeight}%` }}
                      />
                    </div>
                  </div>
                }
              />
              <TooltipPopup side="top">
                평균 {bucket.avgCpuPercent.toFixed(1)}%, 최대 {bucket.maxCpuPercent.toFixed(1)}%
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ResourceHistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/60 p-0.5">
      {RESOURCE_HISTORY_WINDOWS.map((option) => (
        <button
          key={option.windowMs}
          type="button"
          className={cn(
            "h-6 rounded-sm px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground",
            selectedWindowMs === option.windowMs && "bg-muted text-foreground",
          )}
          onClick={() => onSelect(option.windowMs)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ProcessResourceHistoryTable({
  processes,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessResourceHistorySummary>;
  emptyLabel: string;
}) {
  const shallowestChildDepth = processes.reduce<number | null>((minDepth, process) => {
    if (process.isServerRoot) return minDepth;
    return minDepth === null ? process.depth : Math.min(minDepth, process.depth);
  }, null);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(64vh,44rem)] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[980px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[16%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">프로세스</th>
            <th className="px-3 py-2 text-right font-semibold">CPU 시간</th>
            <th className="px-3 py-2 text-right font-semibold">현재</th>
            <th className="px-3 py-2 text-right font-semibold">평균</th>
            <th className="px-3 py-2 text-right font-semibold">최대</th>
            <th className="px-3 py-2 text-right font-semibold">최대 메모리</th>
            <th className="px-3 py-2 font-semibold">명령</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                {emptyLabel}
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={process.processKey} className="hover:bg-muted/20">
              <td className="px-4 py-2 align-middle sm:pl-5">
                <ResourceHistoryProcessNameCell
                  process={process}
                  visualDepth={
                    process.isServerRoot || shallowestChildDepth === null
                      ? 0
                      : Math.max(1, process.depth - shallowestChildDepth + 1)
                  }
                />
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatCpuTime(process.cpuSecondsApprox)}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.currentCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.avgCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.maxRssBytes)}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.command}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground sm:pr-5">
                {process.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function DiagnosticsLastChecked({ checkedAt }: { checkedAt: DateTime.Utc | null }) {
  useRelativeTimeTick();
  const relative = getRelativeTimeState(checkedAt ? DateTime.formatIso(checkedAt) : null);

  if (relative.status === "missing") {
    return <span className="text-[11px] text-muted-foreground/50">확인 중</span>;
  }

  if (relative.status === "invalid") {
    return <span className="text-[11px] text-muted-foreground/50">확인 시각 없음</span>;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {relative.suffix ? (
        <>
          확인: <span className="font-mono tabular-nums">{relative.value}</span> {relative.suffix}
        </>
      ) : (
        <>확인: {relative.value}</>
      )}
    </span>
  );
}

function DiagnosticsRefreshButton({
  isPending,
  label,
  onClick,
}: {
  isPending: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            disabled={isPending}
            onClick={onClick}
            aria-label={label}
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function DiagnosticsSettingsPanel() {
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const [resourceWindowMs, setResourceWindowMs] = useState(15 * 60_000);
  const selectedResourceWindow =
    RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === resourceWindowMs) ??
    RESOURCE_HISTORY_WINDOWS[1];
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
  );
  const {
    data: processData,
    error: processError,
    isPending: isProcessPending,
    refresh: refreshProcesses,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  );
  const {
    data: resourceData,
    error: resourceError,
    isPending: isResourcePending,
    refresh: refreshResources,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processResourceHistory({
          environmentId,
          input: {
            windowMs: selectedResourceWindow.windowMs,
            bucketMs: selectedResourceWindow.bucketMs,
          },
        }),
  );
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openLogsDirectoryError, setOpenLogsDirectoryError] = useState<string | null>(null);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);

  const openLogsDirectory = useCallback(() => {
    const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
    if (!logsDirectoryPath) return;

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenLogsDirectoryError("사용 가능한 편집기가 없습니다.");
      return;
    }
    if (environmentId === null) {
      setOpenLogsDirectoryError("선택된 실행 환경이 없습니다.");
      return;
    }

    setIsOpeningLogsDirectory(true);
    setOpenLogsDirectoryError(null);
    void (async () => {
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: logsDirectoryPath,
          editor,
        },
      });
      setIsOpeningLogsDirectory(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setOpenLogsDirectoryError(
          error instanceof Error ? error.message : "로그 폴더를 열지 못했습니다.",
        );
      }
    })();
  }, [availableEditors, environmentId, observability?.logsDirectoryPath, openInEditor]);

  const isInitialLoading = isPending && data === null;
  const isProcessInitialLoading = isProcessPending && processData === null;
  const signalProcess = useCallback(
    (pid: number, signal: ServerProcessSignal) => {
      if (
        signal === "SIGKILL" &&
        !window.confirm(`프로세스 ${pid}에 SIGKILL을 보낼까요? 프로세스가 이를 처리할 수 없습니다.`)
      ) {
        return;
      }
      if (environmentId === null) {
        return;
      }
      const process = processData?.processes.find((entry) => entry.pid === pid);
      if (process === undefined) {
        return;
      }

      setSignalingPid(pid);
      void (async () => {
        const result = await signalServerProcess({
          environmentId,
          input: { pid, startTimeMs: process.startTimeMs, signal },
        });
        setSignalingPid(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: `${signal}을 보내지 못했습니다`,
              description:
                error instanceof Error ? error.message : `${signal} 전송에 실패했습니다.`,
            });
          }
          return;
        }
        if (!result.value.signaled) {
          const message = Option.getOrUndefined(result.value.message);
          refreshProcesses();
          if (isStaleProcessSignalMessage(message)) {
            toastManager.add({
              type: "info",
              title: "프로세스가 이미 종료되었습니다",
              description:
                "이 프로세스는 더 이상 T3 서버의 하위 프로세스가 아닙니다. 이미 종료되었을 수 있습니다.",
            });
            return;
          }

          toastManager.add({
            type: "error",
            title: `${signal}을 보내지 못했습니다`,
            description: message ?? `${signal} 전송에 실패했습니다.`,
          });
          return;
        }
        refreshProcesses();
      })();
    },
    [environmentId, processData?.processes, refreshProcesses, signalServerProcess],
  );

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;

  return (
    <SettingsPageContainer className="max-w-6xl gap-10">
      <ResourceTelemetryDiagnostics />

      <SettingsSection
        title="실행 중인 프로세스"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={processData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isProcessPending}
              label="프로세스 진단 새로고침"
              onClick={refreshProcesses}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="하위 프로세스"
            value={processData ? formatCount(processData.processCount) : "..."}
          />
          <StatBlock
            label="CPU"
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : "..."}
            tooltip="현재 서버 프로세스에서 실행 중인 모든 하위 프로세스의 CPU 합계입니다. 데스크톱 셸과 그 밖의 상위 프로세스는 포함하지 않습니다."
          />
          <StatBlock
            label="메모리"
            value={processData ? formatBytes(processData.totalRssBytes) : "..."}
            tooltip="현재 서버 프로세스에서 실행 중인 모든 하위 프로세스의 상주 메모리 합계입니다. 데스크톱 셸과 그 밖의 상위 프로세스는 포함하지 않습니다."
          />
          <StatBlock label="서버 PID" value={processData ? String(processData.serverPid) : "..."} />
        </StatsGrid>
        {processDiagnosticsError || processError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processDiagnosticsError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processDiagnosticsError.message}</span>
              </div>
            ) : null}
            {processError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessDiagnosticsTable
          processes={processData?.processes ?? []}
          signalingPid={signalingPid}
          onSignal={signalProcess}
          emptyLabel={
            isProcessInitialLoading
              ? "실행 중인 프로세스를 불러오는 중..."
              : "실행 중인 하위 프로세스가 없습니다."
          }
        />
      </SettingsSection>

      <SettingsSection
        title="리소스 기록"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsLastChecked checkedAt={resourceData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label="리소스 기록 새로고침"
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="CPU 시간"
            value={resourceData ? formatCpuTime(resourceData.totalCpuSecondsApprox) : "..."}
            tooltip="선택한 기간 동안 T3 서버 루트 프로세스와 하위 프로세스가 사용한 대략적인 CPU 시간입니다. 샘플링된 프로세스가 CPU를 사용할 때만 늘어나며, 기간이 이동하면 오래된 샘플은 제외됩니다."
          />
          <StatBlock
            label="샘플"
            value={resourceData ? formatCount(resourceData.retainedSampleCount) : "..."}
            tooltip="서버가 메모리에 보관 중인 프로세스 샘플입니다. 서버를 다시 시작하면 초기화됩니다."
          />
          <StatBlock
            label="수집 간격"
            value={resourceData ? formatDuration(resourceData.sampleIntervalMs) : "..."}
          />
          <StatBlock
            label="프로세스"
            value={resourceData ? formatCount(resourceData.topProcesses.length) : "..."}
          />
        </StatsGrid>
        {processResourceError || resourceError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processResourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processResourceError.message}</span>
              </div>
            ) : null}
            {resourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{resourceError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessResourceHistoryChart buckets={resourceData?.buckets ?? []} />
        <ProcessResourceHistoryTable
          processes={resourceData?.topProcesses ?? []}
          emptyLabel={
            isResourcePending && resourceData === null
              ? "프로세스 리소스 샘플을 수집하는 중..."
              : "이 기간에 수집된 프로세스 리소스 샘플이 없습니다."
          }
        />
      </SettingsSection>

      <SettingsSection
        title="추적 진단"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!observability?.logsDirectoryPath || isOpeningLogsDirectory}
                    onClick={openLogsDirectory}
                    aria-label="로그 폴더 열기"
                  >
                    <FolderOpenIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">로그 폴더 열기</TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label="추적 진단 새로고침"
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock label="스팬" value={data ? formatCount(data.recordCount) : "..."} />
          <StatBlock
            label="실패"
            value={data ? formatCount(data.failureCount) : "..."}
            tone={data && data.failureCount > 0 ? "danger" : "default"}
          />
          <StatBlock
            label="느린 스팬"
            value={data ? formatCount(data.slowSpanCount) : "..."}
            tooltip={
              data
                ? `${formatDuration(data.slowSpanThresholdMs)} 이상 걸린 일반 작업 스팬입니다(장기 구독·AI 턴 제외).`
                : "설정된 느린 스팬 기준 이상인 일반 작업 스팬입니다(장기 구독·AI 턴 제외)."
            }
            tone={data && data.slowSpanCount > 0 ? "warning" : "default"}
          />
          <StatBlock
            label="분석 오류"
            value={data ? formatCount(data.parseErrorCount) : "..."}
            tone={data && data.parseErrorCount > 0 ? "warning" : "default"}
          />
        </StatsGrid>
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {openLogsDirectoryError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{openLogsDirectoryError}</span>
              </div>
            ) : null}
            {traceDiagnosticsError ? (
              <div
                className={cn(
                  "flex items-start gap-2",
                  traceDiagnosticsPartialFailure
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-destructive",
                )}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {traceDiagnosticsPartialFailure
                    ? `일부 추적 파일을 읽지 못해 진단 결과가 완전하지 않을 수 있습니다. ${traceDiagnosticsError.message}`
                    : traceDiagnosticsError.message}
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="최근 실패">
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable headers={["스팬", "원인", "소요 시간", "종료"]}>
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.endedAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? "실패 기록을 불러오는 중..." : "실패한 스팬이 없습니다."}
          />
        )}
      </SettingsSection>

      <SettingsSection title="자주 발생한 실패">
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={["스팬", "횟수", "원인", "마지막 발생"]}
            minTableWidth="min-w-[760px]"
          >
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(failure.count)}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.lastSeenAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? "실패 그룹을 불러오는 중..." : "반복된 실패가 없습니다."}
          />
        )}
      </SettingsSection>

      <SettingsSection title="가장 느린 스팬 (장기 구독 · AI 턴 제외)">
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={["스팬", "소요 시간", "종료", "추적"]}
            minTableWidth="min-w-[900px]"
            columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  {formatRelativeNoWrap(span.endedAt)}
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              isInitialLoading ? "느린 스팬을 불러오는 중..." : "느린 일반 작업 스팬이 없습니다."
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="장기 구독 · AI 턴 현황">
        <StatsGrid>
          <StatBlock
            label="장기 구독"
            value={data ? formatCount(data.longLivedSubscriptionCount ?? 0) : "..."}
            tooltip="창이 열려 있는 동안 유지되는 실시간 구독 연결 스팬입니다. 유지 시간이 길어도 지연 오류가 아닙니다."
          />
          <StatBlock
            label="구독 버퍼 넘침"
            value={data ? formatCount(data.subscriptionBufferOverflowCount ?? 0) : "..."}
            tooltip="실시간 구독의 live buffer가 가득 차 연결이 끊어진 횟수입니다."
            tone={data && (data.subscriptionBufferOverflowCount ?? 0) > 0 ? "danger" : "default"}
          />
          <StatBlock
            label="장기 AI 턴"
            value={data ? formatCount(data.longRunningTurnCount ?? 0) : "..."}
            tooltip="본래 수 분 이상 실행될 수 있는 AI 응답 턴·하위 위임 스팬입니다."
          />
        </StatsGrid>
        {data && (data.longLivedSubscriptions?.length ?? 0) > 0 ? (
          <div className="border-t border-border/60">
            <DiagnosticsTable
              headers={["구독 스팬", "유지 시간", "첫 응답(TTFB)", "상태", "종료"]}
              minTableWidth="min-w-[820px]"
              columnWidths={["w-[42%]", "w-[14%]", "w-[14%]", "w-[16%]", "w-[14%]"]}
            >
              {data.longLivedSubscriptions!.map((span) => (
                <tr key={`${span.traceId}:${span.spanId}`}>
                  <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                    {span.name}
                  </td>
                  <td className="px-4 py-3 align-top font-mono tabular-nums">
                    {formatDuration(span.durationMs)}
                  </td>
                  <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                    {span.ttfbMs !== undefined ? formatDuration(span.ttfbMs) : "-"}
                  </td>
                  <td className="px-4 py-3 align-top text-xs">
                    {span.bufferOverflow ? (
                      <span className="font-medium text-destructive">버퍼 넘침</span>
                    ) : (
                      <span className="text-muted-foreground">정상 유지</span>
                    )}
                  </td>
                  <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                    {formatRelativeNoWrap(span.endedAt)}
                  </td>
                </tr>
              ))}
            </DiagnosticsTable>
          </div>
        ) : (
          <div className="border-t border-border/60">
            <EmptyRows
              label={
                isInitialLoading
                  ? "구독 현황을 불러오는 중..."
                  : "기록된 장기 구독 스팬이 없습니다."
              }
            />
          </div>
        )}
        {data && (data.longRunningTurns?.length ?? 0) > 0 ? (
          <div className="border-t border-border/60">
            <DiagnosticsTable
              headers={["AI 턴 · 위임 스팬", "소요 시간", "종료", "추적"]}
              minTableWidth="min-w-[900px]"
              columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
            >
              {data.longRunningTurns!.map((span) => (
                <tr key={`${span.traceId}:${span.spanId}`}>
                  <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                    {span.name}
                  </td>
                  <td className="px-4 py-3 align-top font-mono tabular-nums">
                    {formatDuration(span.durationMs)}
                  </td>
                  <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                    {formatRelativeNoWrap(span.endedAt)}
                  </td>
                  <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                    <TraceIdCell traceId={span.traceId} />
                  </td>
                </tr>
              ))}
            </DiagnosticsTable>
          </div>
        ) : null}
      </SettingsSection>

      <ExecutionLedgerDiagnosticsCard
        summary={data?.executionLedger}
        isInitialLoading={isInitialLoading}
      />

      <SettingsSection id="worker-engine" title="작업자 엔진 (메일박스 · 승인 게이트 · Worktree)">
        <WorkerEnginePanel mode="diagnostics" />
      </SettingsSection>

      <SettingsSection title="스팬 로그">
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[920px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">시각</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">수준</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">스팬</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">메시지</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pr-5">추적</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      {formatRelativeNoWrap(event.seenAt)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase text-foreground/80">
                        {event.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="truncate font-medium text-foreground">{event.spanName}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      <ExpandableText
                        collapsedClassName="line-clamp-2"
                        expandLabel="메시지 전체 보기"
                        text={event.message}
                      />
                    </td>
                    <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground sm:pr-5">
                      <TraceIdCell traceId={event.traceId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <EmptyRows
            label={isInitialLoading ? "최근 로그를 불러오는 중..." : "경고나 오류가 없습니다."}
          />
        )}
      </SettingsSection>

      <SettingsSection title="주요 스팬 이름">
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={["스팬", "횟수", "실패", "평균", "최대"]}
            minTableWidth="min-w-[760px]"
            columnWidths={["w-[48%]", "w-[13%]", "w-[13%]", "w-[13%]", "w-[13%]"]}
          >
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.count)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.failureCount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "스팬 이름을 불러오는 중..." : "스팬이 없습니다."} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
