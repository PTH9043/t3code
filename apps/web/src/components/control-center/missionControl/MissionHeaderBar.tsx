import type { MissionControlSnapshot } from "@t3tools/contracts";
import {
  ActivityIcon,
  CheckCircle2Icon,
  CoinsIcon,
  LogOutIcon,
  OctagonAlertIcon,
  PlayIcon,
  PowerIcon,
  RadarIcon,
  ShieldAlertIcon,
  UsersIcon,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

export type MissionStatusFilter = "all" | "active" | "approval" | "completed";

export function MissionHeaderBar(props: {
  readonly snapshot: MissionControlSnapshot;
  readonly activeFilter: MissionStatusFilter;
  readonly terminableMissionCount: number;
  readonly onFilterChange: (next: MissionStatusFilter) => void;
  readonly onOpenSyncMeeting: () => void;
  readonly onToggleKillSwitch: () => void;
  readonly onShutdownMissionControl: () => void;
  readonly onExitMissionControl: () => void;
  readonly onRunHeartbeat: () => void;
  readonly busyAction: string | null;
}) {
  const { snapshot, activeFilter } = props;
  const { counts, budget } = snapshot;

  const chips: ReadonlyArray<{
    readonly id: MissionStatusFilter;
    readonly label: string;
    readonly count: number;
    readonly tone: string;
  }> = [
    {
      id: "active",
      label: "일하는 중",
      count: counts.working,
      tone:
        counts.working > 0
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "",
    },
    {
      id: "approval",
      label: "결재 대기",
      count: counts.awaitingApproval,
      tone:
        counts.awaitingApproval > 0
          ? "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300"
          : "",
    },
    {
      id: "all",
      label: "대기 크루",
      count: counts.idle,
      tone: "",
    },
    {
      id: "completed",
      label: "오늘 완료",
      count: counts.completedToday,
      tone: counts.completedToday > 0 ? "border-primary/30 bg-primary/10 text-primary" : "",
    },
  ];

  return (
    <section
      data-mission-header-bar=""
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <RadarIcon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">
                자율 운영실 (Mission Control)
              </h2>
              {budget.killSwitchActive ? (
                <Badge variant="error" size="sm">
                  <OctagonAlertIcon className="size-3" />
                  자율 운영실 종료됨
                </Badge>
              ) : (
                <Badge variant="success" size="sm">
                  <CheckCircle2Icon className="size-3" />
                  가드레일 가동
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              크루별 모델을 언제든 유동 변경하고, 실제 대화창과 연동해 자율 협업·결재·보고를 한
              화면에서 제어합니다.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.busyAction !== null}
            onClick={props.onRunHeartbeat}
          >
            <ActivityIcon className="size-3.5" />
            Zero-Token 점검
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.busyAction !== null}
            onClick={props.onOpenSyncMeeting}
          >
            <UsersIcon className="size-3.5" />
            회의 소집
          </Button>
          {budget.killSwitchActive ? (
            <>
              {props.terminableMissionCount > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.busyAction !== null}
                  onClick={props.onShutdownMissionControl}
                >
                  <PowerIcon className="size-3.5" />
                  남은 미션 종료 ({props.terminableMissionCount})
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={props.busyAction !== null}
                onClick={props.onToggleKillSwitch}
              >
                <PlayIcon className="size-3.5" />
                운영실 재가동
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.busyAction !== null}
                onClick={props.onToggleKillSwitch}
                title="실행 중 미션을 결재 대기 상태로 일시 동결합니다"
              >
                <ShieldAlertIcon className="size-3.5" />
                긴급 일시중지
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={props.busyAction !== null}
                onClick={props.onShutdownMissionControl}
                title="진행 중·결재 대기 미션을 모두 종료하고 크루를 대기 상태로 되돌린 뒤 자율 운영실을 종료합니다"
              >
                <PowerIcon className="size-3.5" />
                운영실 종료
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.onExitMissionControl}
            title="자율 운영실 화면을 닫고 대화창으로 돌아갑니다"
          >
            <LogOutIcon className="size-3.5" />
            나가기
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => {
            const selected = activeFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => props.onFilterChange(selected ? "all" : chip.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  selected
                    ? "border-primary bg-primary/15 text-primary ring-1 ring-primary/30"
                    : chip.tone || "border-border bg-background/70 text-foreground hover:bg-muted"
                }`}
              >
                <span>{chip.label}</span>
                <span className="rounded-full bg-background/80 px-1.5 py-0.2 text-[11px] font-semibold tabular-nums">
                  {chip.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground tabular-nums">
            <CoinsIcon className="size-3.5 text-primary" />
            금일 비용 ${budget.dailySpentUsd.toFixed(4)} / ${budget.dailyLimitUsd.toFixed(2)}
          </span>
          <Badge variant={budget.cacheHitRatePercent >= 50 ? "success" : "outline"} size="sm">
            Prompt Cache {budget.cacheHitRatePercent.toFixed(1)}%
          </Badge>
          <span className="hidden tabular-nums sm:inline">
            Zero-Token 스킵 {budget.zeroTokenSkipsCount}회
          </span>
        </div>
      </div>
    </section>
  );
}
