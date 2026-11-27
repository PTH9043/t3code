import type {
  EnvironmentId,
  MissionApprovalAction,
  MissionControlSnapshot,
  MissionRoleModelOverride,
  ProjectId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  PlayIcon,
  RadarIcon,
  RotateCcwIcon,
  SendIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import {
  MISSION_STATUS_META,
  TRIGGER_REASON_LABELS,
  buildMissionProviderOptions,
  isMissionTerminable,
} from "~/components/control-center/missionControl/missionControlUi.logic";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

function formatFailure(failure: unknown): string {
  const squashed = squashAtomCommandFailure(failure as never);
  if (squashed instanceof Error && squashed.message.trim()) return squashed.message;
  if (typeof squashed === "string" && squashed.trim()) return squashed;
  if (
    typeof squashed === "object" &&
    squashed !== null &&
    "message" in squashed &&
    typeof (squashed as { message?: unknown }).message === "string"
  ) {
    return (squashed as { message: string }).message;
  }
  return "요청 처리에 실패했습니다.";
}

/**
 * 실제 대화창 상단 자율 미션 도크 (ThreadMissionDock).
 *
 * - 현재 열린 실제 대화창(`threadId`)에서 곧바로 자율 미션을 지시·실행하고,
 *   각 크루(기획/개발/검수)의 모델을 그 자리에서 유동적으로 교체할 수 있다.
 * - 진행 중이거나 결재 대기 중인 미션이 있으면 대화창 안에서 즉시 진행 상태 확인 및
 *   `[승인 / 수정 지시 후 재개 / 반려]` 결재를 완료하고, 자율 운영실 대시보드로 이동할 수 있다.
 */
const DOCK_HIDDEN_STORAGE_KEY = "t3.threadMissionDock.hidden";

function readDockHiddenPref(): boolean {
  try {
    return (
      typeof window !== "undefined" && window.localStorage.getItem(DOCK_HIDDEN_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export const ThreadMissionDock = memo(function ThreadMissionDock(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
}) {
  const navigate = useNavigate();
  const [dockHidden, setDockHidden] = useState<boolean>(readDockHiddenPref);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const [requireFinalApproval, setRequireFinalApproval] = useState(true);
  const [showModelOverrides, setShowModelOverrides] = useState(false);
  const [overrideMap, setOverrideMap] = useState<
    Record<string, { readonly providerInstanceId: string; readonly modelSlug: string }>
  >({});
  const [approvalNote, setApprovalNote] = useState("");
  const [busy, setBusy] = useState(false);

  const providerOptions = useMemo(
    () => buildMissionProviderOptions(props.providerStatuses),
    [props.providerStatuses],
  );

  const snapshotAtom = useMemo(
    () =>
      orchestrationEnvironment.missionControlSnapshot({
        environmentId: props.environmentId,
        input: { projectId: props.projectId, threadId: props.threadId },
      }),
    [props.environmentId, props.projectId, props.threadId],
  );
  const streamAtom = useMemo(
    () =>
      orchestrationEnvironment.missionControlStream({
        environmentId: props.environmentId,
        input: { projectId: props.projectId, threadId: props.threadId },
      }),
    [props.environmentId, props.projectId, props.threadId],
  );

  const snapshotQuery = useEnvironmentQuery(snapshotAtom);
  const streamState = useEnvironmentQuery(streamAtom);

  const snapshot: MissionControlSnapshot | null =
    streamState.data?.snapshot ?? snapshotQuery.data ?? null;

  const threadMissions = useMemo(
    () => (snapshot?.missions ?? []).filter((m) => m.threadId === props.threadId),
    [props.threadId, snapshot?.missions],
  );
  const latestMission = threadMissions[0] ?? null;

  const threadPendingApproval = useMemo(
    () => (snapshot?.pendingApprovals ?? []).find((g) => g.threadId === props.threadId) ?? null,
    [props.threadId, snapshot?.pendingApprovals],
  );

  const createMissionCmd = useAtomCommand(orchestrationEnvironment.createMission, {
    label: "대화창 자율 미션 시작",
    reportFailure: false,
  });
  const cancelMissionCmd = useAtomCommand(orchestrationEnvironment.cancelMission, {
    label: "대화창 자율 미션 종료",
    reportFailure: false,
  });
  const deleteMissionCmd = useAtomCommand(orchestrationEnvironment.deleteMission, {
    label: "대화창 자율 미션 삭제",
    reportFailure: false,
  });
  const killSwitchCmd = useAtomCommand(orchestrationEnvironment.setMissionKillSwitch, {
    label: "운영실 재가동",
    reportFailure: false,
  });
  const decideApprovalCmd = useAtomCommand(orchestrationEnvironment.decideMissionApproval, {
    label: "대화창 결재 처리",
    reportFailure: false,
  });
  const upsertCrewCmd = useAtomCommand(orchestrationEnvironment.upsertMissionCrewRole, {
    label: "크루 모델 변경",
    reportFailure: false,
  });

  const setDockHiddenPersisted = useCallback((next: boolean) => {
    setDockHidden(next);
    try {
      if (typeof window !== "undefined") {
        if (next) {
          window.localStorage.setItem(DOCK_HIDDEN_STORAGE_KEY, "1");
        } else {
          window.localStorage.removeItem(DOCK_HIDDEN_STORAGE_KEY);
        }
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const editableRoles = useMemo(
    () => (snapshot?.crewRoles ?? []).filter((r) => r.roleKey !== "digest").slice(0, 4),
    [snapshot?.crewRoles],
  );

  const handleLaunch = useCallback(async () => {
    const trimmed = goalInput.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const roleModelOverrides: MissionRoleModelOverride[] = Object.entries(overrideMap)
        .filter(([, v]) => v.providerInstanceId && v.modelSlug)
        .map(([roleKey, v]) => ({
          roleKey,
          providerInstanceId: v.providerInstanceId,
          modelSlug: v.modelSlug,
        }));

      const res = await createMissionCmd({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          threadId: props.threadId,
          createNewThread: false,
          goalPrompt: trimmed,
          requireFinalApproval,
          ...(roleModelOverrides.length > 0 ? { roleModelOverrides } : {}),
        },
      });
      if (res._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "자율 미션 시작 실패",
          description: formatFailure(res),
        });
        return;
      }
      setGoalInput("");
      setPopoverOpen(false);
      toastManager.add({
        type: "success",
        title: "현재 대화창에서 자율 미션을 시작했습니다",
        description: "진행 상황과 완료 보고가 이 대화창에 실시간으로 기록됩니다.",
      });
      snapshotQuery.refresh();
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "자율 미션 시작 실패",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    createMissionCmd,
    goalInput,
    overrideMap,
    props.environmentId,
    props.projectId,
    props.threadId,
    requireFinalApproval,
    snapshotQuery,
  ]);

  const handlePersistRoleModel = useCallback(
    async (roleKey: string, providerInstanceId: string, modelSlug: string) => {
      const role = snapshot?.crewRoles.find((r) => r.roleKey === roleKey);
      if (!role) return;
      setOverrideMap((prev) => ({ ...prev, [roleKey]: { providerInstanceId, modelSlug } }));
      try {
        await upsertCrewCmd({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            id: role.id,
            roleKey: role.roleKey,
            displayName: role.displayName,
            description: role.description,
            providerInstanceId,
            modelSlug,
            modelTier: role.modelTier,
            fallbackInstanceId: role.fallbackInstanceId,
            fallbackModelSlug: role.fallbackModelSlug,
            systemDirective: role.systemDirective,
            allowedTools: [...role.allowedTools],
            maxTurns: role.maxTurns,
            enabled: role.enabled,
          },
        });
      } catch {
        // Override map still applies to this mission run even if immediate save fails
      }
    },
    [props.environmentId, props.projectId, snapshot?.crewRoles, upsertCrewCmd],
  );

  const handleDecide = useCallback(
    async (action: MissionApprovalAction) => {
      if (!threadPendingApproval || busy) return;
      setBusy(true);
      try {
        const res = await decideApprovalCmd({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            gateId: threadPendingApproval.gateId,
            action,
            ...(approvalNote.trim() ? { note: approvalNote.trim() } : {}),
          },
        });
        if (res._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "결재 처리 실패",
            description: formatFailure(res),
          });
          return;
        }
        setApprovalNote("");
        toastManager.add({
          type: "success",
          title: "결재 결정을 반영했습니다",
        });
        snapshotQuery.refresh();
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "결재 처리 실패",
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusy(false);
      }
    },
    [
      approvalNote,
      busy,
      decideApprovalCmd,
      props.environmentId,
      props.projectId,
      snapshotQuery,
      threadPendingApproval,
    ],
  );

  const handleCancelMission = useCallback(async () => {
    if (!latestMission || !isMissionTerminable(latestMission.status) || busy) return;
    setBusy(true);
    try {
      const res = await cancelMissionCmd({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          missionId: latestMission.id,
          reason: "대화창 자율 미션 바에서 사용자 종료",
        },
      });
      if (res._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "자율 미션 종료 실패",
          description: formatFailure(res),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "자율 미션을 종료했습니다",
      });
      snapshotQuery.refresh();
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "자율 미션 종료 실패",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, cancelMissionCmd, latestMission, props.environmentId, props.projectId, snapshotQuery]);

  const handleDeleteMission = useCallback(async () => {
    if (!latestMission || busy) return;
    setBusy(true);
    try {
      const res = await deleteMissionCmd({
        environmentId: props.environmentId,
        input: { projectId: props.projectId, missionId: latestMission.id },
      });
      if (res._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "자율 미션 삭제 실패",
          description: formatFailure(res),
        });
        return;
      }
      toastManager.add({ type: "success", title: "자율 미션을 삭제했습니다" });
      snapshotQuery.refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, deleteMissionCmd, latestMission, props.environmentId, props.projectId, snapshotQuery]);

  const handleRestartLatestMission = useCallback(async () => {
    if (!latestMission || busy) return;
    setBusy(true);
    try {
      if (snapshot?.budget.killSwitchActive) {
        await killSwitchCmd({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, active: false, reason: "대화창 미션 다시 시작" },
        });
      }
      const res = await createMissionCmd({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          threadId: props.threadId,
          createNewThread: false,
          title: latestMission.title,
          goalPrompt: latestMission.goalPrompt,
          ...(latestMission.doneCriteria.length > 0
            ? { doneCriteria: [...latestMission.doneCriteria] }
            : {}),
          requireFinalApproval,
        },
      });
      if (res._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "자율 미션 다시 시작 실패",
          description: formatFailure(res),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "현재 대화창에서 자율 미션을 다시 시작했습니다",
      });
      snapshotQuery.refresh();
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    createMissionCmd,
    killSwitchCmd,
    latestMission,
    props.environmentId,
    props.projectId,
    props.threadId,
    requireFinalApproval,
    snapshot?.budget.killSwitchActive,
    snapshotQuery,
  ]);

  const openMissionControlDashboard = useCallback(() => {
    void navigate({
      to: "/control-center/$environmentId/$projectId",
      params: { environmentId: props.environmentId, projectId: props.projectId },
      search: { domain: "home", section: "mission-control" },
    });
  }, [navigate, props.environmentId, props.projectId]);

  const latestStatusMeta = latestMission ? MISSION_STATUS_META[latestMission.status] : null;
  const canTerminateLatest = latestMission ? isMissionTerminable(latestMission.status) : false;

  if (dockHidden && !threadPendingApproval) {
    return (
      <div
        data-thread-mission-dock-collapsed=""
        className="flex shrink-0 items-center justify-end gap-2 border-b border-border/40 bg-muted/10 px-3 py-0.5 text-[11px] text-muted-foreground sm:px-5"
      >
        {latestMission && canTerminateLatest && latestStatusMeta ? (
          <Badge variant={latestStatusMeta.variant} size="sm">
            {latestStatusMeta.label}
          </Badge>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setDockHiddenPersisted(false)}
        >
          <RadarIcon className="size-3 text-primary" />
          자율 미션 바 열기
        </button>
      </div>
    );
  }

  return (
    <div data-thread-mission-dock="" className="shrink-0 border-b border-border/60 bg-muted/15">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-muted-foreground sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 font-semibold text-foreground">
            <RadarIcon className="size-3.5 text-primary" />
            자율 미션
          </span>
          {latestMission && latestStatusMeta ? (
            <>
              <Badge variant={latestStatusMeta.variant} size="sm">
                {latestStatusMeta.label}
              </Badge>
              <span className="max-w-56 truncate text-foreground/85">{latestMission.title}</span>
              <span className="hidden tabular-nums sm:inline">
                · ${latestMission.totalCostUsd.toFixed(4)}
              </span>
            </>
          ) : (
            <span className="hidden sm:inline">
              이 대화창에서 크루 모델을 선택해 자율 실행하거나{" "}
              <code className="rounded bg-muted px-1">/mission 목표</code>를 입력하세요
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger render={<Button type="button" size="xs" variant="outline" />}>
              <PlayIcon className="size-3" />
              이 대화창에서 미션 실행
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-96 p-3.5">
              <div className="grid gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">현재 대화창 자율 미션 실행</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setShowModelOverrides((v) => !v)}
                  >
                    <SlidersHorizontalIcon className="size-3" />
                    크루 모델 {showModelOverrides ? "접기" : "변경"}
                  </Button>
                </div>

                <textarea
                  rows={3}
                  placeholder="크루들이 자율적으로 협업해 완료할 목표를 입력하세요..."
                  className="w-full resize-none rounded-lg border border-input bg-background p-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                />

                {showModelOverrides && editableRoles.length > 0 ? (
                  <div className="grid gap-1.5 rounded-lg border border-border/70 bg-muted/25 p-2">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      크루별 실행 모델 (변경 시 즉시 적용·저장)
                    </span>
                    {editableRoles.map((role) => {
                      const currentOverride = overrideMap[role.roleKey];
                      const activeProvId =
                        currentOverride?.providerInstanceId ?? role.providerInstanceId;
                      const activeModel = currentOverride?.modelSlug ?? role.modelSlug;
                      const selectedProv = providerOptions.find(
                        (p) => p.providerInstanceId === activeProvId,
                      );
                      return (
                        <div key={role.roleKey} className="grid grid-cols-12 items-center gap-1">
                          <span className="col-span-3 truncate text-[11px] font-medium">
                            {role.displayName.split(" ")[0]}
                          </span>
                          <select
                            className="col-span-4 h-7 rounded border border-input bg-background px-1 text-[11px]"
                            value={activeProvId}
                            onChange={(e) => {
                              const nextProvId = e.target.value;
                              const found = providerOptions.find(
                                (p) => p.providerInstanceId === nextProvId,
                              );
                              const nextSlug = found?.models[0]?.slug ?? activeModel;
                              void handlePersistRoleModel(role.roleKey, nextProvId, nextSlug);
                            }}
                          >
                            {!selectedProv ? (
                              <option value={activeProvId}>{activeProvId}</option>
                            ) : null}
                            {providerOptions.map((opt) => (
                              <option key={opt.providerInstanceId} value={opt.providerInstanceId}>
                                {opt.displayName}
                              </option>
                            ))}
                          </select>
                          <select
                            className="col-span-5 h-7 rounded border border-input bg-background px-1 text-[11px]"
                            value={activeModel}
                            onChange={(e) =>
                              void handlePersistRoleModel(
                                role.roleKey,
                                activeProvId,
                                e.target.value,
                              )
                            }
                          >
                            {selectedProv &&
                            !selectedProv.models.some((m) => m.slug === activeModel) ? (
                              <option value={activeModel}>{activeModel}</option>
                            ) : null}
                            {(
                              selectedProv?.models ?? [{ slug: activeModel, name: activeModel }]
                            ).map((m) => (
                              <option key={m.slug} value={m.slug}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={requireFinalApproval}
                      onChange={(e) => setRequireFinalApproval(e.target.checked)}
                    />
                    최종 결재 받기
                  </label>
                  <Button
                    type="button"
                    size="xs"
                    disabled={!goalInput.trim() || busy}
                    onClick={() => void handleLaunch()}
                  >
                    <PlayIcon className="size-3" />
                    실행
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>

          {canTerminateLatest ? (
            <Button
              type="button"
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() => void handleCancelMission()}
              title="이 대화창의 진행·결재 대기 자율 미션을 즉시 종료합니다"
            >
              <SquareIcon className="size-3" />
              미션 종료
            </Button>
          ) : latestMission ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void handleRestartLatestMission()}
                title="이 미션을 현재 크루 모델과 채팅방 권한으로 다시 시작합니다"
              >
                <RotateCcwIcon className="size-3" />
                다시 시작
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => void handleDeleteMission()}
                title="이 미션 기록을 삭제합니다"
              >
                <Trash2Icon className="size-3" />
                삭제
              </Button>
            </>
          ) : null}

          <Button type="button" size="xs" variant="ghost" onClick={openMissionControlDashboard}>
            <ExternalLinkIcon className="size-3" />
            자율 운영실 · 합석 회의
          </Button>

          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setDockHiddenPersisted(true)}
            title="대화창 상단 자율 미션 바 숨기기"
            aria-label="자율 미션 바 닫기"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      </div>

      {threadPendingApproval ? (
        <div
          data-thread-mission-approval=""
          className="mx-3 mb-2 grid gap-2 rounded-xl border border-amber-500/45 bg-amber-500/8 px-3 py-2.5 text-xs sm:mx-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="warning" size="sm">
                결재 대기 · {TRIGGER_REASON_LABELS[threadPendingApproval.triggerReason]}
              </Badge>
              <span className="font-semibold">{threadPendingApproval.title}</span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              AI 권고: {threadPendingApproval.aiRecommendation}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              className="h-7 min-w-44 flex-1 text-xs"
              placeholder="한 줄 수정 지시 (선택)"
              value={approvalNote}
              onChange={(e) => setApprovalNote(e.target.value)}
            />
            <Button
              type="button"
              size="xs"
              disabled={busy}
              onClick={() => void handleDecide("approve")}
            >
              <CheckCircle2Icon className="size-3" />
              승인
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void handleDecide("modify_resume")}
            >
              <SendIcon className="size-3" />
              수정 재개
            </Button>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDecide("reject_rollback")}
            >
              <RotateCcwIcon className="size-3" />
              반려
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
});
