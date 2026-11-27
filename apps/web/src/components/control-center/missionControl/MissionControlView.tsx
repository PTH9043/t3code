import type {
  EnvironmentId,
  MissionApprovalAction,
  MissionControlSnapshot,
  MissionCreateInput,
  MissionCrewRoleUpsertInput,
  MissionExecutionStyle,
  MissionInspectArtifactResult,
  MissionRoundtableStartInput,
  MissionRun,
  MissionSynapseWeightRecord,
  ProjectId,
  WorkerTaskRecord,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, LayersIcon, SparklesIcon, UsersIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useServerConfigs, useThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { WorkerWorktreeDiffDialog } from "~/t3x/workerEngine/WorkerWorktreeDiffDialog";
import { CrewTelemetryMatrix } from "./CrewTelemetryMatrix";
import { ExecutiveDigestPanel, MissionApprovalQueue } from "./MissionApprovalQueue";
import { MissionHeaderBar, type MissionStatusFilter } from "./MissionHeaderBar";
import { MissionLogsSplitPane } from "./MissionLogsSplitPane";
import { MissionPipelineBoard } from "./MissionPipelineBoard";
import { QuickMissionComposer } from "./QuickMissionComposer";
import { RoundtableMeetingView } from "./RoundtableMeetingView";
import { filterMissionsByStatus, isMissionTerminable } from "./missionControlUi.logic";

function formatCommandFailureMessage(failure: unknown): string {
  const squashed = squashAtomCommandFailure(failure as never);
  if (squashed instanceof Error && squashed.message.trim().length > 0) {
    return squashed.message;
  }
  if (typeof squashed === "string" && squashed.trim().length > 0) {
    return squashed;
  }
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

export function MissionControlView(props: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  };
  readonly onExit?: () => void;
}) {
  const { project } = props;
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const allThreadShells = useThreadShells();
  const [activeTab, setActiveTab] = useState<"ops" | "roundtable" | "organization">("ops");
  const [activeFilter, setActiveFilter] = useState<MissionStatusFilter>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [diffTask, setDiffTask] = useState<WorkerTaskRecord | null>(null);

  const providers = useMemo(
    () => serverConfigs.get(project.environmentId)?.providers ?? [],
    [project.environmentId, serverConfigs],
  );

  const projectThreads = useMemo(
    () =>
      allThreadShells
        .filter((t) => t.environmentId === project.environmentId && t.projectId === project.id)
        .slice(0, 30)
        .map((t) => ({ id: t.id, title: t.title || t.id })),
    [allThreadShells, project.environmentId, project.id],
  );

  const snapshotAtom = useMemo(
    () =>
      orchestrationEnvironment.missionControlSnapshot({
        environmentId: project.environmentId,
        input: { projectId: project.id },
      }),
    [project.environmentId, project.id],
  );
  const streamAtom = useMemo(
    () =>
      orchestrationEnvironment.missionControlStream({
        environmentId: project.environmentId,
        input: { projectId: project.id },
      }),
    [project.environmentId, project.id],
  );

  const snapshotQuery = useEnvironmentQuery(snapshotAtom);
  const streamState = useEnvironmentQuery(streamAtom);

  const snapshot: MissionControlSnapshot | null =
    streamState.data?.snapshot ?? snapshotQuery.data ?? null;

  const createMissionCmd = useAtomCommand(orchestrationEnvironment.createMission, {
    label: "자율 미션 생성",
    reportFailure: false,
  });
  const cancelMissionCmd = useAtomCommand(orchestrationEnvironment.cancelMission, {
    label: "자율 미션 중단",
    reportFailure: false,
  });
  const deleteMissionCmd = useAtomCommand(orchestrationEnvironment.deleteMission, {
    label: "자율 미션 삭제",
    reportFailure: false,
  });
  const decideApprovalCmd = useAtomCommand(orchestrationEnvironment.decideMissionApproval, {
    label: "미션 결재 처리",
    reportFailure: false,
  });
  const upsertCrewCmd = useAtomCommand(orchestrationEnvironment.upsertMissionCrewRole, {
    label: "크루 모델 저장",
    reportFailure: false,
  });
  const deleteCrewCmd = useAtomCommand(orchestrationEnvironment.deleteMissionCrewRole, {
    label: "크루 삭제",
    reportFailure: false,
  });
  const startRoundtableCmd = useAtomCommand(orchestrationEnvironment.startRoundtableMeeting, {
    label: "합석 회의 시작",
    reportFailure: false,
  });
  const cancelMeetingCmd = useAtomCommand(orchestrationEnvironment.cancelMissionMeeting, {
    label: "합석 회의 중단",
    reportFailure: false,
  });
  const deleteMeetingCmd = useAtomCommand(orchestrationEnvironment.deleteMissionMeeting, {
    label: "합석 회의 삭제",
    reportFailure: false,
  });
  const promoteMeetingCmd = useAtomCommand(orchestrationEnvironment.promoteMeetingToMission, {
    label: "합석 회의 합의안 미션 실행",
    reportFailure: false,
  });
  const setSynapsePrunedCmd = useAtomCommand(orchestrationEnvironment.setMissionSynapsePruned, {
    label: "DyLAN 가지치기 전환",
    reportFailure: false,
  });
  const killSwitchCmd = useAtomCommand(orchestrationEnvironment.setMissionKillSwitch, {
    label: "긴급 중지 전환",
    reportFailure: false,
  });
  const digestNowCmd = useAtomCommand(orchestrationEnvironment.generateMissionDigestNow, {
    label: "일일 보고서 생성",
    reportFailure: false,
  });
  const heartbeatCmd = useAtomCommand(orchestrationEnvironment.runMissionHeartbeatCheck, {
    label: "Zero-Token 상태 점검",
    reportFailure: false,
  });
  const inspectArtifactCmd = useAtomCommand(orchestrationEnvironment.inspectMissionArtifact, {
    label: "아티팩트 원문 열람",
    reportFailure: false,
  });

  const runAction = useCallback(
    async <A, E>(
      actionKey: string,
      fn: () => Promise<AtomCommandResult<A, E>>,
      successTitle?: string,
    ): Promise<A | null> => {
      setBusyAction(actionKey);
      try {
        const res = await fn();
        if (res._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "작업 실행 실패",
            description: formatCommandFailureMessage(res),
          });
          return null;
        }
        if (successTitle) {
          toastManager.add({ type: "success", title: successTitle });
        }
        return res.value;
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "작업 실행 실패",
          description: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const openThread = useCallback(
    (threadId: string) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: project.environmentId, threadId },
      });
    },
    [navigate, project.environmentId],
  );

  const handleCreateMission = useCallback(
    async (input: MissionCreateInput) => {
      const created = await runAction(
        "createMission",
        () =>
          createMissionCmd({
            environmentId: project.environmentId,
            input,
          }),
        "자율 미션을 시작했습니다",
      );
      if (created) {
        snapshotQuery.refresh();
      }
    },
    [createMissionCmd, project.environmentId, runAction, snapshotQuery],
  );

  const handleCancelMission = useCallback(
    async (missionId: string) => {
      await runAction(
        "cancelMission",
        () =>
          cancelMissionCmd({
            environmentId: project.environmentId,
            input: { projectId: project.id, missionId },
          }),
        "미션을 중단했습니다",
      );
      snapshotQuery.refresh();
    },
    [cancelMissionCmd, project.environmentId, project.id, runAction, snapshotQuery],
  );

  const handleDeleteMission = useCallback(
    async (missionId: string) => {
      await runAction(
        "deleteMission",
        () =>
          deleteMissionCmd({
            environmentId: project.environmentId,
            input: { projectId: project.id, missionId },
          }),
        "미션을 삭제했습니다",
      );
      snapshotQuery.refresh();
    },
    [deleteMissionCmd, project.environmentId, project.id, runAction, snapshotQuery],
  );

  const handleRestartMission = useCallback(
    async (mission: MissionRun) => {
      setBusyAction("restartMission");
      try {
        if (snapshot?.budget.killSwitchActive) {
          const ksRes = await killSwitchCmd({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              active: false,
              reason: "미션 다시 시작",
            },
          });
          if (ksRes._tag === "Failure") {
            toastManager.add({
              type: "error",
              title: "운영실 재가동 실패",
              description: formatCommandFailureMessage(ksRes),
            });
            return;
          }
        }
        const res = await createMissionCmd({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            title: mission.title,
            goalPrompt: mission.goalPrompt,
            ...(mission.doneCriteria.length > 0 ? { doneCriteria: [...mission.doneCriteria] } : {}),
            ...(mission.threadId
              ? { threadId: mission.threadId, createNewThread: false }
              : { createNewThread: true }),
            requireFinalApproval: true,
          },
        });
        if (res._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "미션 다시 시작 실패",
            description: formatCommandFailureMessage(res),
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: "미션을 처음부터 다시 시작했습니다",
          description: "현재 설정된 크루 모델과 채팅방 권한으로 실행됩니다.",
        });
        snapshotQuery.refresh();
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "미션 다시 시작 실패",
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusyAction(null);
      }
    },
    [
      createMissionCmd,
      killSwitchCmd,
      project.environmentId,
      project.id,
      snapshot?.budget.killSwitchActive,
      snapshotQuery,
    ],
  );

  const handleClearFinishedMissions = useCallback(async () => {
    const finished = (snapshot?.missions ?? []).filter((m) => !isMissionTerminable(m.status));
    if (finished.length === 0) return;
    setBusyAction("clearFinished");
    try {
      let deletedCount = 0;
      for (const m of finished) {
        const res = await deleteMissionCmd({
          environmentId: project.environmentId,
          input: { projectId: project.id, missionId: m.id },
        });
        if (res._tag === "Success") deletedCount += 1;
      }
      toastManager.add({
        type: "success",
        title: `종료된 미션 ${deletedCount}건을 삭제했습니다`,
      });
      snapshotQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  }, [deleteMissionCmd, project.environmentId, project.id, snapshot?.missions, snapshotQuery]);

  const handleDecideApproval = useCallback(
    async (input: {
      readonly gateId: string;
      readonly action: MissionApprovalAction;
      readonly note?: string;
    }) => {
      await runAction(
        "decideApproval",
        () =>
          decideApprovalCmd({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              gateId: input.gateId,
              action: input.action,
              ...(input.note ? { note: input.note } : {}),
            },
          }),
        "결재 결정을 반영했습니다",
      );
      snapshotQuery.refresh();
    },
    [decideApprovalCmd, project.environmentId, project.id, runAction, snapshotQuery],
  );

  const handleUpsertCrew = useCallback(
    async (input: MissionCrewRoleUpsertInput) => {
      await runAction(
        "upsertCrew",
        () =>
          upsertCrewCmd({
            environmentId: project.environmentId,
            input,
          }),
        `${input.displayName} 모델 설정을 저장했습니다`,
      );
      snapshotQuery.refresh();
    },
    [project.environmentId, runAction, snapshotQuery, upsertCrewCmd],
  );

  const handleDeleteCrew = useCallback(
    async (roleId: string) => {
      await runAction(
        "deleteCrew",
        () =>
          deleteCrewCmd({
            environmentId: project.environmentId,
            input: { projectId: project.id, roleId },
          }),
        "크루를 삭제했습니다",
      );
      snapshotQuery.refresh();
    },
    [deleteCrewCmd, project.environmentId, project.id, runAction, snapshotQuery],
  );

  const handleToggleKillSwitch = useCallback(async () => {
    const nextActive = !(snapshot?.budget.killSwitchActive ?? false);
    await runAction(
      "killSwitch",
      () =>
        killSwitchCmd({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            active: nextActive,
            reason: nextActive ? "운영실 상단 긴급 일시중지 클릭" : "사용자 운영실 재가동",
          },
        }),
      nextActive ? "자율 운영실을 일시 중지했습니다" : "자율 운영실을 재가동했습니다",
    );
    snapshotQuery.refresh();
  }, [
    killSwitchCmd,
    project.environmentId,
    project.id,
    runAction,
    snapshot?.budget.killSwitchActive,
    snapshotQuery,
  ]);

  const terminableMissions = useMemo(
    () => (snapshot ? snapshot.missions.filter((m) => isMissionTerminable(m.status)) : []),
    [snapshot],
  );

  const handleShutdownMissionControl = useCallback(async () => {
    setBusyAction("shutdown");
    try {
      let cancelledCount = 0;
      for (const mission of terminableMissions) {
        const res = await cancelMissionCmd({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            missionId: mission.id,
            reason: "자율 운영실 전체 종료",
          },
        });
        if (res._tag === "Success") {
          cancelledCount += 1;
        }
      }
      const ksRes = await killSwitchCmd({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          active: true,
          reason: "사용자 자율 운영실 종료",
        },
      });
      if (ksRes._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "자율 운영실 종료 실패",
          description: formatCommandFailureMessage(ksRes),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "자율 운영실을 종료했습니다",
        description:
          cancelledCount > 0
            ? `진행·결재 대기 미션 ${cancelledCount}건을 종료하고 모든 크루를 대기 상태로 되돌렸습니다.`
            : "모든 크루를 대기 상태로 두고 자율 실행을 중지했습니다. 필요 시 [운영실 재가동]으로 다시 시작할 수 있습니다.",
      });
      snapshotQuery.refresh();
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "자율 운영실 종료 실패",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  }, [
    cancelMissionCmd,
    killSwitchCmd,
    project.environmentId,
    project.id,
    snapshotQuery,
    terminableMissions,
  ]);

  const handleExitMissionControl = useCallback(() => {
    const firstThread = projectThreads[0];
    if (firstThread) {
      openThread(firstThread.id);
      return;
    }
    props.onExit?.();
  }, [openThread, projectThreads, props]);

  const handleRunHeartbeat = useCallback(async () => {
    const res = await runAction("heartbeat", () =>
      heartbeatCmd({
        environmentId: project.environmentId,
        input: { projectId: project.id },
      }),
    );
    if (res) {
      toastManager.add({
        type: "info",
        title: "Zero-Token 상태 점검 완료 (LLM 0회 호출)",
        description: res.summary,
      });
      snapshotQuery.refresh();
    }
  }, [heartbeatCmd, project.environmentId, project.id, runAction, snapshotQuery]);

  const handleGenerateDigest = useCallback(async () => {
    await runAction(
      "digest",
      () =>
        digestNowCmd({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        }),
      "오늘의 보고서를 갱신했습니다",
    );
    snapshotQuery.refresh();
  }, [digestNowCmd, project.environmentId, project.id, runAction, snapshotQuery]);

  const handleStartRoundtableMeeting = useCallback(
    async (input: MissionRoundtableStartInput) => {
      const created = await runAction(
        "startMeeting",
        () =>
          startRoundtableCmd({
            environmentId: project.environmentId,
            input,
          }),
        "감독자 주도 동등 합석 회의를 시작했습니다",
      );
      if (created) {
        snapshotQuery.refresh();
      }
    },
    [project.environmentId, runAction, snapshotQuery, startRoundtableCmd],
  );

  const handleCancelMeeting = useCallback(
    async (meetingId: string) => {
      await runAction(
        "cancelMeeting",
        () =>
          cancelMeetingCmd({
            environmentId: project.environmentId,
            input: { projectId: project.id, meetingId },
          }),
        "합석 회의를 중단했습니다",
      );
      snapshotQuery.refresh();
    },
    [cancelMeetingCmd, project.environmentId, project.id, runAction, snapshotQuery],
  );

  const handleDeleteMeeting = useCallback(
    async (meetingId: string) => {
      await runAction(
        "deleteMeeting",
        () =>
          deleteMeetingCmd({
            environmentId: project.environmentId,
            input: { projectId: project.id, meetingId },
          }),
        "합석 회의 기록을 삭제했습니다",
      );
      snapshotQuery.refresh();
    },
    [deleteMeetingCmd, project.environmentId, project.id, runAction, snapshotQuery],
  );

  const handlePromoteMeetingToMission = useCallback(
    async (input: {
      readonly meetingId: string;
      readonly executionStyle: MissionExecutionStyle;
    }) => {
      const promoted = await runAction(
        "promoteMeeting",
        () =>
          promoteMeetingCmd({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              meetingId: input.meetingId,
              executionStyle: input.executionStyle,
              requireFinalApproval: true,
            },
          }),
        "합석 회의 합의안을 자율 운영실 미션으로 인계했습니다",
      );
      if (promoted) {
        setActiveTab("ops");
        snapshotQuery.refresh();
      }
    },
    [project.environmentId, project.id, promoteMeetingCmd, runAction, snapshotQuery],
  );

  const handleToggleSynapsePruned = useCallback(
    async (weight: MissionSynapseWeightRecord) => {
      await runAction(
        "setSynapsePruned",
        () =>
          setSynapsePrunedCmd({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              domainTag: weight.domainTag,
              roleKey: weight.roleKey,
              providerInstanceId: weight.providerInstanceId,
              modelSlug: weight.modelSlug,
              pruned: !weight.pruned,
            },
          }),
        weight.pruned ? "DyLAN 가지치기를 해제했습니다" : "DyLAN 가지치기를 적용했습니다",
      );
      snapshotQuery.refresh();
    },
    [project.environmentId, project.id, runAction, setSynapsePrunedCmd, snapshotQuery],
  );

  const handleInspectArtifact = useCallback(
    async (artifactId: string): Promise<MissionInspectArtifactResult | null> => {
      return await runAction("inspectArtifact", () =>
        inspectArtifactCmd({
          environmentId: project.environmentId,
          input: { projectId: project.id, artifactId },
        }),
      );
    },
    [inspectArtifactCmd, project.environmentId, project.id, runAction],
  );

  const visibleMissions = useMemo(
    () => (snapshot ? filterMissionsByStatus(snapshot.missions, activeFilter) : []),
    [activeFilter, snapshot],
  );

  if (!snapshot) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        {snapshotQuery.isPending
          ? "자율 운영실 상태를 불러오는 중입니다..."
          : "자율 운영실 연결을 확인하지 못했습니다."}
      </div>
    );
  }

  return (
    <div data-mission-control-view="" className="grid min-w-0 gap-4">
      <MissionHeaderBar
        snapshot={snapshot}
        activeFilter={activeFilter}
        terminableMissionCount={terminableMissions.length}
        onFilterChange={setActiveFilter}
        onOpenSyncMeeting={() => setActiveTab("roundtable")}
        onToggleKillSwitch={() => void handleToggleKillSwitch()}
        onShutdownMissionControl={() => void handleShutdownMissionControl()}
        onExitMissionControl={handleExitMissionControl}
        onRunHeartbeat={() => void handleRunHeartbeat()}
        busyAction={busyAction}
      />

      {/* 통합 3탭 내비게이션: 자율 운영실(상하 지휘+지속 목표) / 합석 회의실(감독자+전원 동등) / 조직·DyLAN */}
      <nav
        aria-label="자율 운영실 및 합석 회의실 모드 전환"
        className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-xs"
      >
        <button
          type="button"
          onClick={() => setActiveTab("ops")}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors ${
            activeTab === "ops"
              ? "bg-primary text-primary-foreground shadow-xs"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <LayersIcon className="size-3.5" />
          자율 운영실 (상하 지휘 · 지속 목표)
          <Badge variant={activeTab === "ops" ? "outline" : "info"} size="sm">
            {snapshot.missions.length}
          </Badge>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("roundtable")}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors ${
            activeTab === "roundtable"
              ? "bg-primary text-primary-foreground shadow-xs"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <UsersIcon className="size-3.5" />
          합석 회의실 (감독자 진행 · 전원 동등)
          <Badge variant={activeTab === "roundtable" ? "outline" : "info"} size="sm">
            {(snapshot.meetings ?? []).length}
          </Badge>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("organization")}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors ${
            activeTab === "organization"
              ? "bg-primary text-primary-foreground shadow-xs"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <BotIcon className="size-3.5" />
          조직 · 역할군 · DyLAN 진화
          <Badge variant="outline" size="sm">
            {snapshot.crewRoles.length}
          </Badge>
        </button>
      </nav>

      {snapshot.budget.killSwitchActive ? (
        <div
          data-mission-shutdown-banner=""
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/35 bg-destructive/8 px-4 py-2.5 text-xs"
        >
          <span className="text-foreground">
            자율 운영실이 종료(중지)되어 있습니다. 모든 자율 미션·회의 실행이 멈춰 있으며, 필요할 때
            언제든 다시 가동할 수 있습니다.
          </span>
          <Button
            type="button"
            size="xs"
            disabled={busyAction !== null}
            onClick={() => void handleToggleKillSwitch()}
          >
            운영실 재가동
          </Button>
        </div>
      ) : null}

      {activeTab === "ops" ? (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="grid min-w-0 content-start gap-4 xl:col-span-7">
              <MissionPipelineBoard
                environmentId={project.environmentId}
                missions={visibleMissions}
                crewRoles={snapshot.crewRoles}
                onOpenThread={openThread}
                onOpenWorktreeDiff={(task) => setDiffTask(task)}
                onCancelMission={handleCancelMission}
                onRestartMission={handleRestartMission}
                onDeleteMission={handleDeleteMission}
                onClearFinishedMissions={handleClearFinishedMissions}
                busy={busyAction !== null}
              />

              <CrewTelemetryMatrix
                environmentId={project.environmentId}
                projectId={project.id}
                roles={snapshot.crewRoles}
                providers={providers}
                onUpsertRole={handleUpsertCrew}
                onDeleteRole={handleDeleteCrew}
                busy={busyAction !== null}
              />
            </div>

            <div className="grid min-w-0 content-start gap-4 xl:col-span-5">
              <QuickMissionComposer
                projectId={project.id}
                projectThreads={projectThreads}
                killSwitchActive={snapshot.budget.killSwitchActive}
                busy={busyAction !== null}
                onCreateMission={handleCreateMission}
              />

              <MissionApprovalQueue
                pendingApprovals={snapshot.pendingApprovals}
                recentResolved={snapshot.recentResolvedApprovals}
                busy={busyAction !== null}
                onDecide={handleDecideApproval}
                onOpenThread={openThread}
              />

              <ExecutiveDigestPanel
                reports={snapshot.reports}
                busy={busyAction === "digest"}
                onGenerateDigestNow={handleGenerateDigest}
              />
            </div>
          </div>

          <MissionLogsSplitPane
            activities={snapshot.activities}
            handoffs={snapshot.handoffs}
            onInspectArtifact={handleInspectArtifact}
          />
        </>
      ) : null}

      {activeTab === "roundtable" ? (
        <RoundtableMeetingView
          projectId={project.id}
          roles={snapshot.crewRoles}
          meetings={snapshot.meetings ?? []}
          projectThreads={projectThreads}
          killSwitchActive={snapshot.budget.killSwitchActive}
          busy={busyAction !== null}
          onStartMeeting={handleStartRoundtableMeeting}
          onCancelMeeting={handleCancelMeeting}
          onDeleteMeeting={handleDeleteMeeting}
          onPromoteToMission={handlePromoteMeetingToMission}
          onOpenThread={openThread}
        />
      ) : null}

      {activeTab === "organization" ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="grid min-w-0 content-start gap-4 xl:col-span-7">
            <CrewTelemetryMatrix
              environmentId={project.environmentId}
              projectId={project.id}
              roles={snapshot.crewRoles}
              providers={providers}
              onUpsertRole={handleUpsertCrew}
              onDeleteRole={handleDeleteCrew}
              busy={busyAction !== null}
            />
          </div>
          <section className="grid min-w-0 content-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs xl:col-span-5">
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-4 text-primary" />
              <div>
                <h3 className="text-sm font-semibold">DyLAN 역전파 시냅스 가중치 · 가지치기</h3>
                <p className="text-[11px] text-muted-foreground">
                  회의·미션 완료마다 채택 기여도와 토큰 효율을 역산해 최적 이기종 팀 조합을
                  학습합니다.
                </p>
              </div>
            </div>
            {(snapshot.synapseWeights ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
                아직 누적된 DyLAN 시냅스 가중치가 없습니다. 자율 미션 또는 합석 회의를 1회 이상
                완료하면 도메인별 모델 기여도가 자동 기록됩니다.
              </div>
            ) : (
              <div className="grid min-w-0 gap-2">
                {(snapshot.synapseWeights ?? []).map((w) => {
                  const recommendPrune = w.sampleCount >= 5 && w.importanceEma < 0.32;
                  return (
                    <div
                      key={`${w.domainTag}:${w.roleKey}:${w.providerInstanceId}:${w.modelSlug}`}
                      className="grid min-w-0 gap-1.5 rounded-xl border border-border/80 bg-background/70 p-2.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" size="sm">
                            {w.domainTag}
                          </Badge>
                          <span className="font-semibold">{w.roleKey}</span>
                          {w.pruned ? (
                            <Badge variant="error" size="sm">
                              비활성(Pruned)
                            </Badge>
                          ) : recommendPrune ? (
                            <Badge variant="warning" size="sm">
                              가지치기 권장
                            </Badge>
                          ) : null}
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant={w.pruned ? "outline" : "ghost"}
                          disabled={busyAction !== null}
                          onClick={() => void handleToggleSynapsePruned(w)}
                        >
                          {w.pruned ? "복구" : "가지치기"}
                        </Button>
                      </div>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {w.providerInstanceId} / {w.modelSlug}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                        <span>기여도 {Math.round(w.importanceEma * 100)}%</span>
                        <span>·</span>
                        <span>토큰효율 {Math.round(w.tokenEfficiencyEma * 100)}%</span>
                        <span>·</span>
                        <span>채택률 {Math.round(w.adoptionRate * 100)}%</span>
                        <span>·</span>
                        <span>표본 {w.sampleCount}회</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}

      <WorkerWorktreeDiffDialog
        task={diffTask}
        open={diffTask !== null}
        onOpenChange={(open) => {
          if (!open) setDiffTask(null);
        }}
        requestContext={{ environmentId: project.environmentId }}
        onMutated={() => {
          snapshotQuery.refresh();
        }}
      />
    </div>
  );
}
