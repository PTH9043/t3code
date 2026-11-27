import type { MissionApprovalAction, MissionDecisionCard, MissionReport } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ClockIcon,
  FileTextIcon,
  InboxIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { TRIGGER_REASON_LABELS, formatRelativeTimeKo } from "./missionControlUi.logic";

export function MissionApprovalQueue(props: {
  readonly pendingApprovals: ReadonlyArray<MissionDecisionCard>;
  readonly recentResolved: ReadonlyArray<MissionDecisionCard>;
  readonly busy: boolean;
  readonly onDecide: (input: {
    readonly gateId: string;
    readonly action: MissionApprovalAction;
    readonly note?: string;
  }) => Promise<void>;
  readonly onOpenThread?: (threadId: string) => void;
}) {
  const [notesByGate, setNotesByGate] = useState<Record<string, string>>({});

  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <InboxIcon className="size-4 text-amber-500" />
          <h3 className="text-sm font-semibold">결재함 (Tier 2 승인 게이트)</h3>
        </div>
        <Badge variant={props.pendingApprovals.length > 0 ? "warning" : "outline"} size="sm">
          대기 {props.pendingApprovals.length}건
        </Badge>
      </div>

      {props.pendingApprovals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          결정할 일이 없습니다. 고위험·최종 병합·예산 도달 건만 이곳에 올라옵니다.
        </div>
      ) : (
        <div className="grid gap-3">
          {props.pendingApprovals.map((card) => {
            const note = notesByGate[card.gateId] ?? "";
            const isSnoozed = Boolean(card.snoozedUntilMs && card.snoozedUntilMs > Date.now());
            return (
              <article
                key={card.gateId}
                data-approval-card={card.gateId}
                className="grid gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="warning" size="sm">
                      {TRIGGER_REASON_LABELS[card.triggerReason]}
                    </Badge>
                    <Badge variant="outline" size="sm">
                      위험: {card.riskLevel}
                    </Badge>
                    {isSnoozed ? (
                      <Badge variant="info" size="sm">
                        보류 중
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeTimeKo(card.createdAtMs)}
                  </span>
                </div>

                <div>
                  <h4 className="text-xs font-semibold">{card.title}</h4>
                  <pre className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background/80 p-2 font-sans text-[11px] leading-relaxed text-foreground/90">
                    {card.context3LinesMd}
                  </pre>
                </div>

                <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[11px]">
                  <span className="font-semibold text-primary">AI 권고안: </span>
                  <span className="text-foreground/90">{card.aiRecommendation}</span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground tabular-nums">
                  <span>
                    비용 ${card.estimatedCostUsd.toFixed(4)} · 변경 파일 {card.changedFilesCount}건
                  </span>
                  {card.threadId && props.onOpenThread ? (
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => props.onOpenThread?.(card.threadId!)}
                    >
                      연결 대화창 열기 →
                    </button>
                  ) : null}
                </div>

                <Input
                  className="h-8 text-xs"
                  placeholder="한 줄 수정 지시 또는 메모 (수정 지시 후 재개 시 크루에 즉시 주입)"
                  value={note}
                  onChange={(e) =>
                    setNotesByGate((prev) => ({ ...prev, [card.gateId]: e.target.value }))
                  }
                />

                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  <Button
                    type="button"
                    size="xs"
                    disabled={props.busy}
                    onClick={() =>
                      void props.onDecide({
                        gateId: card.gateId,
                        action: "approve",
                        ...(note.trim() ? { note: note.trim() } : {}),
                      })
                    }
                  >
                    <CheckCircle2Icon className="size-3" />
                    승인
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={props.busy}
                    onClick={() =>
                      void props.onDecide({
                        gateId: card.gateId,
                        action: "modify_resume",
                        note: note.trim() || "지시 반영 후 재개",
                      })
                    }
                  >
                    <SendIcon className="size-3" />
                    수정 재개
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive"
                    disabled={props.busy}
                    onClick={() =>
                      void props.onDecide({
                        gateId: card.gateId,
                        action: "reject_rollback",
                        ...(note.trim() ? { note: note.trim() } : {}),
                      })
                    }
                  >
                    <RotateCcwIcon className="size-3" />
                    반려·원복
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() =>
                      void props.onDecide({
                        gateId: card.gateId,
                        action: "snooze",
                      })
                    }
                  >
                    <ClockIcon className="size-3" />
                    1h 보류
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {props.recentResolved.length > 0 ? (
        <div className="grid gap-1.5 border-t border-border/60 pt-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">최근 처리한 결재</p>
          {props.recentResolved.slice(0, 4).map((item) => (
            <div
              key={item.gateId}
              className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-2.5 py-1.5 text-[11px]"
            >
              <span className="truncate text-foreground/85">{item.title}</span>
              <Badge variant="outline" size="sm">
                {item.resolution ?? item.status}
              </Badge>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ExecutiveDigestPanel(props: {
  readonly reports: ReadonlyArray<MissionReport>;
  readonly busy: boolean;
  readonly onGenerateDigestNow: () => Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileTextIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">오늘 보고서 · 완료 브리핑</h3>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={props.busy}
          onClick={() => void props.onGenerateDigestNow()}
        >
          <RefreshCwIcon className={`size-3 ${props.busy ? "animate-spin" : ""}`} />
          즉시 갱신
        </Button>
      </div>

      {props.reports.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
          완료된 미션이나 일일 보고서가 아직 없습니다.
        </p>
      ) : (
        <div className="grid gap-2">
          {props.reports.slice(0, 6).map((report) => {
            const expanded = expandedId === report.id;
            return (
              <article
                key={report.id}
                className="grid gap-1.5 rounded-xl border border-border/70 bg-background/60 p-2.5 text-xs"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 text-left"
                  onClick={() => setExpandedId(expanded ? null : report.id)}
                >
                  <span className="truncate font-semibold">{report.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatRelativeTimeKo(report.createdAtMs)}
                  </span>
                </button>
                {report.summary3Lines.length > 0 && !expanded ? (
                  <ul className="grid gap-0.5 pl-3.5 text-[11px] text-muted-foreground list-disc">
                    {report.summary3Lines.slice(0, 3).map((line, idx) => (
                      <li key={idx} className="line-clamp-1">
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {expanded ? (
                  <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 font-sans text-[11px] leading-relaxed">
                    {report.bodyMd}
                  </pre>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
