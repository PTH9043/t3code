import type {
  EnvironmentId,
  MissionCrewRole,
  MissionRun,
  WorkerTaskRecord,
} from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  LayersIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  CIRCUIT_BREAKER_META,
  DAG_STEP_STATUS_META,
  MISSION_STATUS_META,
  findCrewDisplayName,
  formatRelativeTimeKo,
  formatTokensCompact,
  isMissionTerminable,
} from "./missionControlUi.logic";

export function MissionPipelineBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly missions: ReadonlyArray<MissionRun>;
  readonly crewRoles: ReadonlyArray<MissionCrewRole>;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenWorktreeDiff: (task: WorkerTaskRecord) => void;
  readonly onCancelMission: (missionId: string) => Promise<void>;
  readonly onRestartMission: (mission: MissionRun) => Promise<void>;
  readonly onDeleteMission: (missionId: string) => Promise<void>;
  readonly onClearFinishedMissions?: () => Promise<void>;
  readonly busy: boolean;
}) {
  const finishedCount = props.missions.filter((m) => !isMissionTerminable(m.status)).length;

  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LayersIcon className="size-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">미션 파이프라인 (DAG · 대화창 연동)</h3>
            <p className="text-[11px] text-muted-foreground">
              각 미션은 실제 프로젝트 대화창과 연결되어 기획→구현→이종 검수 단계로 자율 실행됩니다.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {finishedCount > 0 && props.onClearFinishedMissions ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={props.busy}
              onClick={() => void props.onClearFinishedMissions?.()}
              title="중단·실패·완료된 미션 카드를 한 번에 삭제합니다"
            >
              <Trash2Icon className="size-3" />
              종료 미션 정리 ({finishedCount})
            </Button>
          ) : null}
          <Badge variant="outline" size="sm">
            {props.missions.length}건
          </Badge>
        </div>
      </div>

      {props.missions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
          진행 중이거나 최근 실행한 자율 미션이 없습니다. 우측 지시창이나 실제 대화창의{" "}
          <code className="rounded bg-muted px-1 py-0.5">/mission</code> 명령으로 시작해 보세요.
        </div>
      ) : (
        <div className="grid gap-3">
          {props.missions.map((mission) => {
            const statusMeta = MISSION_STATUS_META[mission.status];
            const breakerMeta = CIRCUIT_BREAKER_META[mission.circuitBreakerState];
            const isTerminable = isMissionTerminable(mission.status);
            const cachePct =
              mission.totalTokensUsed > 0
                ? Math.round((mission.totalCachedTokens / mission.totalTokensUsed) * 100)
                : 0;
            const budgetPct = Math.min(
              100,
              Math.round((mission.totalCostUsd / Math.max(0.01, mission.budgetLimitUsd)) * 100),
            );

            return (
              <article
                key={mission.id}
                data-mission-card={mission.id}
                className="grid gap-2.5 rounded-xl border border-border/80 bg-background/70 p-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={statusMeta.variant} size="sm">
                        {statusMeta.label}
                      </Badge>
                      {mission.executionStyle === "persistent_goal" ? (
                        <Badge variant="info" size="sm">
                          지속 목표
                        </Badge>
                      ) : null}
                      {mission.sourceMeetingId ? (
                        <Badge variant="success" size="sm">
                          합석 회의 승격
                        </Badge>
                      ) : null}
                      {mission.circuitBreakerState !== "OK" ? (
                        <Badge variant={breakerMeta.variant} size="sm">
                          {breakerMeta.label}
                        </Badge>
                      ) : null}
                      <h4 className="line-clamp-2 break-words text-sm font-semibold">
                        {mission.title}
                      </h4>
                    </div>
                    <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                      {mission.digestLine ?? mission.goalPrompt}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {mission.threadId ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => props.onOpenThread(mission.threadId!)}
                      >
                        <ExternalLinkIcon className="size-3" />
                        대화창 열기
                      </Button>
                    ) : null}
                    {mission.activeTaskId && mission.worktreePath ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          props.onOpenWorktreeDiff({
                            taskId: mission.activeTaskId!,
                            runId: mission.id,
                            threadId: mission.threadId ?? `mission-${mission.id}`,
                            ownerTurnId: null,
                            callerKind: "orchestra",
                            dedupKey: mission.id,
                            idempotencyKey: null,
                            role: mission.activeRoleId ?? "coder",
                            targetInstanceId: "mission",
                            targetModel: null,
                            specText: mission.goalPrompt,
                            ragFactsJson: null,
                            status: "blocked",
                            activeDispatchId: null,
                            fencingEpoch: mission.leaseEpoch,
                            failureCount: mission.repeatErrorCount,
                            worktreeMode: "isolated",
                            worktreePath: mission.worktreePath,
                            worktreeBranch: mission.worktreeBranch,
                            worktreeBaseRef: null,
                            worktreeState: "review_ready",
                            cwd: mission.worktreePath ?? "",
                            outcome: null,
                            createdAtMs: mission.createdAtMs,
                            updatedAtMs: mission.updatedAtMs,
                            finishedAtMs: mission.completedAtMs,
                          })
                        }
                      >
                        <FileDiffIcon className="size-3" />
                        Diff 보기
                      </Button>
                    ) : null}
                    {isTerminable ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => void props.onCancelMission(mission.id)}
                      >
                        <SquareIcon className="size-3" />
                        미션 종료
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={props.busy}
                          onClick={() => void props.onRestartMission(mission)}
                          title="현재 크루 모델과 채팅방 권한 설정으로 이 미션을 처음부터 다시 시작합니다"
                        >
                          <RotateCcwIcon className="size-3" />
                          다시 시작
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={props.busy}
                          onClick={() => void props.onDeleteMission(mission.id)}
                          title="이 미션 기록을 파이프라인에서 삭제합니다"
                        >
                          <Trash2Icon className="size-3" />
                          삭제
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* DAG 단계 칩 */}
                {mission.dagSteps.length > 0 ? (
                  <div className="grid min-w-0 grid-cols-1 gap-1.5 md:grid-cols-3">
                    {mission.dagSteps.map((step) => {
                      const effectiveStatus =
                        mission.status === "AWAITING_APPROVAL" && step.status === "RUNNING"
                          ? "AWAITING_APPROVAL"
                          : step.status;
                      const stepMeta = DAG_STEP_STATUS_META[effectiveStatus];
                      const modelLabel = `${step.providerInstanceId ?? "-"} / ${step.modelSlug ?? "-"}`;
                      return (
                        <div
                          key={step.stepId}
                          className="min-w-0 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2 text-[11px]"
                        >
                          <div className="flex min-w-0 items-center justify-between gap-1">
                            <span className="truncate font-semibold">{step.roleDisplayName}</span>
                            <Badge variant={stepMeta.variant} size="sm" className="shrink-0">
                              {stepMeta.label}
                            </Badge>
                          </div>
                          <p
                            title={modelLabel}
                            className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                          >
                            {modelLabel}
                          </p>
                          {step.summary ? (
                            <p className="mt-1 line-clamp-1 text-[11px] text-foreground/85">
                              {step.summary}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {/* 토큰·비용·캐시·워크트리 메타 바 */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground tabular-nums">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>담당: {findCrewDisplayName(props.crewRoles, mission.activeRoleId)}</span>
                    <span>·</span>
                    <span>
                      토큰 {formatTokensCompact(mission.totalTokensUsed)} (캐시 {cachePct}%)
                    </span>
                    <span>·</span>
                    <span>
                      비용 ${mission.totalCostUsd.toFixed(4)} / ${mission.budgetLimitUsd.toFixed(2)}{" "}
                      ({budgetPct}%)
                    </span>
                    <span>·</span>
                    <span>
                      홉 {mission.hopCount}/4 · 재작업 {mission.reworkCount}/2
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {mission.worktreeBranch ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[10px]">
                        <GitBranchIcon className="size-3" />
                        {mission.worktreeBranch}
                      </span>
                    ) : null}
                    <span>{formatRelativeTimeKo(mission.updatedAtMs)}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
